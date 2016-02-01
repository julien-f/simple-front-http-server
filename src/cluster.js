import cluster from 'cluster'
import forOwn from 'lodash/forOwn'
import noop from 'lodash/noop'
import once from 'lodash/once'

// ===================================================================

const debug = message => console.log(message)

const makeCallbackGroup = (noopWrapper => cb => {
  if (!cb) {
    return noopWrapper
  }

  let count = 0
  cb = (cb => () => {
    if (!--count) {
      cb()
    }
  })(cb)
  return () => (++count, cb)
})(() => noop)

// ===================================================================

const startWorker = (env, cb) => {
  cb = once(cb)
  cluster.once('online', () => {
    setTimeout(cb, 1e4)
  })
  cluster.once('listening', cb)

  cluster.fork(env)
}

const stopWorker = (worker, cb) => {
  worker.once('exit', cb)
  worker.process.connected && worker.disconnect()
}

// Start a new worker and stop the old one.
const restartWorker = (worker, env, cb) =>
  startWorker(env, () => stopWorker(worker, cb))

// ===================================================================

let master
export default exec => {
  if (!cluster.isMaster) {
    throw new Error('cannot be called in a worker')
  }

  if (master) {
    throw new Error('this cluster has a master already')
  }

  cluster.setupMaster({
    exec
  })

  let nWorkers = 0
  let busy = false
  master = {
    env: undefined,
    workers: 0,

    sync (cb, restartExisting = false) {
      if (busy) {
        return
      }

      busy = true

      const then = makeCallbackGroup(() => {
        busy = false
        cb && cb()
      })

      let newWorkers = this.workers - nWorkers
      const { env } = master
      if (newWorkers < 0) {
        forOwn(cluster.workers, worker => {
          if (newWorkers) {
            newWorkers++
            return stopWorker(worker, then())
          }
          if (restartExisting) {
            return restartWorker(worker, env, then())
          }
          return false
        })
      } else {
        if (restartExisting) {
          forOwn(cluster.workers, worker => {
            restartWorker(worker, env, then())
          })
        }

        while (newWorkers--) {
          startWorker(env, then())
        }
      }
    }
  }

  cluster.on('fork', worker => {
    debug(`worker ${worker.id} started`)
    ++nWorkers

    worker.on('exit', () => {
      --nWorkers

      if (worker.suicide) {
        debug(`worker ${worker.id} stopped`)
      } else {
        debug(`worker ${worker.id} exited abnormally`)
      }

      master.sync()
    })
  })

  return master
}
