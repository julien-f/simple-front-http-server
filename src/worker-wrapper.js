const config = JSON.parse(process.env.SFHS_CONFIG)
delete process.env.SFHS_CONFIG

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

const worker = require('./worker').default
require('exec-promise')(() => worker(config))
