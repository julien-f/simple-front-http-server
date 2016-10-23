import compress from 'koa-compress'
import conditionalGet from 'koa-conditional-get'
import createCallback from 'lodash/iteratee'
import etag from 'koa-etag'
import eventToPromise from 'event-to-promise'
import find from 'lodash/find'
import helmet from 'koa-helmet'
import isArray from 'lodash/isArray'
import isString from 'lodash/isString'
import Koa from 'koa'
import koaConvert from 'koa-convert'
import map from 'lodash/map'
import morgan from 'koa-morgan'
import responseTime from 'koa-response-time'
import serveIndex from 'koa-serve-index'
import serveStatic from 'koa-serve-static'
import { all as pAll } from 'promise-toolbox'
import { create as createHttpServer } from 'http-server-plus'
import { createSecureContext } from 'tls'
import { createServer as createProxyServer } from 'http-proxy'
import { format as formatUrl } from 'url'
import { readFile } from 'fs-promise'

// ===================================================================

const ensureArray = value => value === undefined
  ? []
  : isArray(value)
    ? value
    : [ value ]

const trueFn = () => true

// ===================================================================

const ACTIONS = Object.freeze({
  index: serveIndex,

  // SHOULD NOT be used in production.
  info: () => ctx => {
    ctx.body = process.versions
  },

  // TODO: support WebSocket.
  proxy (conf) {
    const proxy = createProxyServer({
      target: conf,
      xfwd: true
    }).on('proxyRes', (proxyRes, req) => {
      if (req.isSpdy) {
        delete proxyRes.headers.connection
        delete proxyRes.headers['keep-alive']
        delete proxyRes.headers['proxy-connection']
        delete proxyRes.headers['transfer-encoding']
        delete proxyRes.headers.upgrade
      }
    })

    const action = ctx => new Promise((resolve, reject) => {
      ctx.respond = false
      proxy.web(ctx.req, ctx.res, error => error
        ? reject(error)
        : resolve()
      )
    })
    action.ws = ctx => new Promise((resolve, reject) => {
      ctx.respond = false
      proxy.ws(ctx.req, ctx.socket, ctx.head, error => error
        ? reject(error)
        : resolve()
      )
    })

    return action
  },

  redirect ({ code, url }) {
    return isString(url)
      ? async ctx => {
        code && (ctx.status = code)
        ctx.redirect(code, url)
      }
      : async ctx => {
        const {
          hostname,
          path: pathname,
          port,
          protocol,
          search
        } = ctx

        code && (ctx.status = code)
        ctx.redirect(formatUrl({
          hostname,
          pathname,
          port,
          protocol,
          search,
          ...url
        }))
      }
  },

  static: serveStatic
})

const normalizeRule = ({
  action,
  when
}) => {
  let actionName, actionConf
  if (isArray(action)) {
    [ actionName, ...actionConf ] = action
  } else {
    actionName = action
    actionConf = []
  }

  return {
    action: koaConvert(ACTIONS[actionName](...actionConf)),

    // TODO: support prefix matching (necessary for static action).
    match: when ? createCallback(when) : trueFn
  }
}

// ===================================================================

const HOSTNAME_RE = /:hostname\b/g

export default async config => {
  // Starts listening.
  const server = createHttpServer()
  await Promise.all(map(ensureArray(config.listen), async ({
    certTpl,
    keyTpl,
    ...conf
  }) => {
    const { cert, key } = conf
    if (cert && key) {
      [
        conf.cert,
        conf.key
      ] = await Promise.all([
        readFile(cert),
        readFile(key)
      ])

      if (certTpl && keyTpl) {
        const cache = Object.create(null)
        const inProgress = Object.create(null)

        conf.SNICallback = (hostname, cb) => {
          const cached = cache[hostname]
          if (cached !== undefined) {
            return cb(null, cached)
          }

          let queue = inProgress[hostname]
          if (queue) {
            return queue.push(cb)
          }

          queue = inProgress[hostname] = [ cb ]
          const dispatch = (context) => {
            cache[hostname] = context

            for (let i = 0, n = queue.length; i < n; ++i) {
              queue[i](null, context)
            }
            delete inProgress[hostname]
          }

          const hostnameFn = () => hostname
          pAll.call({
            cert: readFile(certTpl.replace(HOSTNAME_RE, hostnameFn)),
            key: readFile(keyTpl.replace(HOSTNAME_RE, hostnameFn))
          }).then(
            (context) => {
              dispatch(createSecureContext(context))
            },
            (error) => {
              console.error(error)

              // No context for this hostname.
              dispatch(null)
            }
          )
        }
      }
    }

    try {
      const niceAddress = await server.listen(conf)
      console.log(`listening on ${niceAddress}`)
    } catch ({ code, niceAddress }) {
      console.error(`${code}: failed to listen on ${niceAddress}`)
    }
  }))

  const app = new Koa()
  server.on('request', app.callback())

  // Patch koa to accept both legacy and modern middlewares.
  // See: https://github.com/koajs/convert#migration
  app.use = (use =>
    middleware => use.call(app, koaConvert(middleware))
  )(app.use)

  config.logFormat && app.use(morgan(config.logFormat))

  app.use(responseTime())

  // Help secure HTTP apps.
  // https://www.npmjs.com/package/helmet
  app.use(helmet())

  app.use(conditionalGet())

  app.use(etag())

  app.use(compress())

  {
    const rules = map(ensureArray(config.rules), normalizeRule)
    const n = rules.length

    const exec = (ctx, next, i) => {
      while (i < n) {
        const rule = rules[i++]
        if (rule.match(ctx)) {
          return rule.action(ctx, () => exec(ctx, next, i))
        }
      }

      return next()
    }
    app.use((ctx, next) => exec(ctx, next, 0))

    server.on('upgrade', (req, socket, head) => {
      const ctx = Object.defineProperties(app.createContext(req), {
        head: { value: head },
        socket: { value: socket }
      })
      const rule = find(rules, r => r.action.ws && r.match(ctx))
      return rule && rule.action.ws(ctx)
    })
  }

  await eventToPromise(server, 'close')
}
