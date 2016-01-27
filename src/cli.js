#!/usr/bin/env node

import compress from 'koa-compress'
import conditionalGet from 'koa-conditional-get'
import createCallback from 'lodash/iteratee'
import etag from 'koa-etag'
import eventToPromise from 'event-to-promise'
import execPromise from 'exec-promise'
import find from 'lodash/find'
import helmet from 'koa-helmet'
import isArray from 'lodash/isArray'
import isString from 'lodash/isString'
import Koa from 'koa'
import koaConvert from 'koa-convert'
import map from 'lodash/map'
import minimist from 'minimist'
import morgan from 'koa-morgan'
import responseTime from 'koa-response-time'
import serveStatic from 'koa-serve-static'
import { create as createHttpServer } from 'http-server-plus'
import { createServer as createProxyServer } from 'http-proxy'
import { format as formatUrl } from 'url'
import { load as loadConfig } from 'app-conf'
import { readFile } from 'fs-promise'

import {
  name as pkgName,
  version as pkgVersion
} from '../package'

// ===================================================================

const ensureArray = value => value === undefined
  ? []
  : isArray(value)
    ? value
    : [ value ]

// ===================================================================

const ACTIONS = Object.freeze({
  // TODO: support WebSocket.
  proxy (conf) {
    const proxy = createProxyServer({
      target: conf
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
  ...properties
}) => {
  let actionName, actionConf
  if (isArray(action)) {
    [ actionName, actionConf ] = action
  } else {
    actionName = action
  }

  return {
    action: ACTIONS[actionName](actionConf),

    // TODO: support prefix matching (necessary for static action).
    match: createCallback(properties)
  }
}

// ===================================================================

const help = `
Usage: ${pkgName}

${pkgName} v${pkgVersion}
`

execPromise(async args => {
  const flags = minimist(args, {
    boolean: 'help',
    alias: {
      help: 'h'
    }
  })

  if (flags.help) {
    return help
  }

  const config = await loadConfig('simple-front-http-server')

  // Starts listening.
  const server = createHttpServer()
  await Promise.all(map(ensureArray(config.listen), async conf => {
    const { cert, key } = conf
    if (cert && key) {
      [
        conf.cert,
        conf.key
      ] = await Promise.all([
        readFile(cert),
        readFile(key)
      ])
    }

    try {
      const niceAddress = await server.listen(conf)
      console.log(`listening on ${niceAddress}`)
    } catch ({ code, niceAddress }) {
      console.error(`${code}: failed to listen on ${niceAddress}`)
    }
  }))

  // Drops privileges if requested.
  {
    const { user, group } = config
    if (group) {
      process.setgid(group)
      console.log('group changed to', group)
    }

    if (user) {
      process.setuid(user)
      console.log('user changed to', user)
    }
  }

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

    app.use((ctx, next) => {
      const rule = find(rules, r => r.match(ctx))
      return rule
        ? rule.action(ctx)
        : next()
    })

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
})
