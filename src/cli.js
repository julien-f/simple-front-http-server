#!/usr/bin/env node

import assign from 'lodash/assign'
import compression from 'compression'
import createCallback from 'lodash/iteratee'
import eventToPromise from 'event-to-promise'
import execPromise from 'exec-promise'
import connect from 'connect'
import forEach from 'lodash/forEach'
import helmet from 'helmet'
import isArray from 'lodash/isArray'
import isString from 'lodash/isString'
import map from 'lodash/map'
import minimist from 'minimist'
import responseTime from 'response-time'
import serveStatic from 'serve-static'
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
    })

    return (req, res) => {
      proxy.web(req, res, error => {
        console.error('proxy error', error)
      })
    }
  },

  redirect ({ code = 302, url }) {
    return isString(url)
      ? (req, res) => {
        res.redirect(code, url)
      }
      : (req, res) => {
        const {
          protocol,
          hostname,
          port,
          path
        } = req

        res.redirect(code, formatUrl(assign({
          protocol,
          hostname,
          port,
          path
        }, url)))
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

  const app = connect()
  server.on('request', app)

  app.use(responseTime())

  // Help secure HTTP apps.
  // https://www.npmjs.com/package/helmet
  app.use(helmet())

  app.use(compression())

  {
    const rules = map(ensureArray(config.rules), normalizeRule)

    app.use((req, res) => {
      forEach(rules, rule => {
        if (rule.match(req)) {
          rule.action(req, res)

          return false
        }
      })
    })
  }

  await eventToPromise(server, 'close')
})
