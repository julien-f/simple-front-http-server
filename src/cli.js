#!/usr/bin/env node

import clusterMaster from 'cluster-master'
import execPromise from 'exec-promise'
import minimist from 'minimist'
import { cpus as getCpus } from 'os'
import { load as loadConfig } from 'app-conf'

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

  const config = await loadConfig('simple-front-http-server')

  let { workers } = config
  if (workers == null || workers === true) {
    workers = getCpus().length
  } else if (workers === false) {
    workers = 1
  }

  clusterMaster({
    exec: `${__dirname}/worker-wrapper.js`,
    env: {
      SFHS_CONFIG: JSON.stringify(config)
    },
    size: workers
  })

  // Never stops.
  return new Promise(() => {})
})
