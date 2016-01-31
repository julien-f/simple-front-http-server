#!/usr/bin/env node

import execPromise from 'exec-promise'
import minimist from 'minimist'
import { cpus as getCpus } from 'os'
import { load as loadConfig } from 'app-conf'

import createCluster from './cluster'
import {
  name as pkgName,
  version as pkgVersion
} from '../package'

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

  const cluster = createCluster(`${__dirname}/worker-wrapper.js`)

  const init = () => loadConfig('simple-front-http-server').then(config => {
    cluster.env = {
      SFHS_CONFIG: JSON.stringify(config)
    }

    let { workers } = config
    if (workers == null || workers === true) {
      workers = getCpus().length
    } else if (workers === false) {
      workers = 1
    }
    cluster.workers = workers

    return new Promise(resolve => cluster.sync(resolve, true))
  })

  await init().catch(::console.error)
  process.on('SIGHUP', () => {
    console.log('SIGHUP')
    return init()
  })

  // Never stops.
  return new Promise(resolve => {
    process.on('SIGINT', () => {
      cluster.workers = 0
      cluster.sync(resolve)
    })
  })
})
