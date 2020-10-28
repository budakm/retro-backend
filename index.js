const app = require('express')()
const server = require('http').Server(app)
const bodyParser = require('body-parser')
const Pool = require('pg').Pool
const WebSocket = require('ws')
const wss = new WebSocket.Server({port: process.env.SOCKET_PORT})
const uniqid = require('uniqid')

const _ = require('lodash')
const RetroError = require('./RetroError')

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(/\s*,\s*/)[0]
  console.log('New Client Connected from ' + ip)
  ws.send(JSON.stringify({type: 'connected', message: 'New Client Connected from ' + ip}))
})

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({extended: true}))
app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header('Access-Control-Allow-Methods', '*');
  res.header("Access-Control-Allow-Headers", "x-access-token, Origin, X-Requested-With, Content-Type, Accept");
  next();
});

const db = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'retro',
  password: 'postgres',
  port: 5432,
})

// Checking Method Is Table Editable? //
const checkIfTaskIsEditable = async (id, req) => {
  const task = await db.query('SELECT * FROM tasks WHERE id=$1 AND deleted_at=0', [id])
  if (!task.rows[0]) {
    throw new RetroError('Task Not Found', 404)
  }
  if (task.rows[0].locked_by && task.rows[0].locked_by !== req.headers['x-access-token']) {
    throw new RetroError('The task is currently edited by someone else', 400)
  }
  return task.rows[0]
}

//  WEB Socket Message Sender  //
const wssSendDt = (dt) => {
  console.log('sent')
  const wssMessage = JSON.stringify({type: 'dt', dt})
  wss.clients.forEach((ws) => ws.send(wssMessage))
}

/// ////
/// Get Task List ////
/// ////
app.get('/tasks', async (req, res) => {

  const token = req.headers['x-access-token'] || uniqid()
  const dt = (new Date).getTime()
  
  let tasks = []
  const result = await db.query('SELECT * FROM tasks WHERE updated_at>$1 AND deleted_at=0 ORDER BY sort', [req.query.dt || 0], (err, response) => {

    if (err) {

      throw new RetroError('Tasks are not loaded', 400)

    } else {

      tasks = response.rows.map(item => ({
        ..._.omit(item, 'locked_by', 'locking_switch_requested_by'),
        locked: !!(item.locked_by && item.locked_by !== token),
        locking_requested: item.locking_switch_requested_by === token,
        edit_permission: item.locked_by === token,
        edit_permission_requested_by_someone_else: item.locked_by === token && !!item.locking_switch_requested_by
      }))

      let deletedTasks = []
      if (req.query.since) {
        const rows = db.query('SELECT id FROM tasks WHERE deleted_at>$1', [req.query.since],  (err, response2) => {
          if (response2) {
            deletedTasks = response2.rows.map(item => item.id) 
          }
        })
      
      }
      res.send({tasks, dt, token, deletedTasks})
    }
  })

})


/// ////
/// Post Task ////
/// ////
app.post('/tasks', async (req, res) => {

  try {
    
    if (!req.body.text) {
      throw new RetroError('Text field must be filled', 400)
    }

    const dt = (new Date).getTime()

    const result = await db.query('INSERT INTO tasks(text, col, created_at, updated_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.body.text, req.body.col, dt, dt])

    if (result.rows[0]) {

      let id = result.rows[0].id;
        
      await db.query('UPDATE tasks SET sort=$1 WHERE id=$2', [id * 1000, id])
      wssSendDt(dt)
      res.send()
    } 
    else {
      throw new RetroError('Failed to create new item in DB', 500)
    }
  
  } catch (error) {
    console.error(error)
    res.status(error.status || 500).send({error: error.message})
  }
})

/// ////
/// Update Task ////
/// ////
app.patch('/tasks/:id', async (req, res) => {

  try {
    if (!req.body.text) {
      throw new RetroError('Text field must be filled', 400)
    }

    const task = await checkIfTaskIsEditable(req.params.id, req)
    const dt = (new Date).getTime()
    await db.query('UPDATE tasks SET text=$1, updated_at=$2 WHERE id=$3', [req.body.text, dt, task.id], (err, response) => {
      if (response) {
        wssSendDt(dt)
        res.send()
      }
    })
  } catch (error) {
    console.error(error)
    res.status(error.status || 500).send({error: error.message})
  }
})

/// ////
/// Delete Task ////
/// ////
app.delete('/tasks/:id', async (req, res) => {
  try {
    const task = await checkIfTaskIsEditable(req.params.id, req)
    const dt = (new Date).getTime()
    await db.query('UPDATE tasks SET updated_at=$1, deleted_at=$2 WHERE id=$3', [dt, dt, req.params.id], (err, response) => {
      if (response) {
        console.log('task deleted ok', req.params.id)
        wssSendDt(dt)
        res.send()
      }
    })
  } catch (error) {
    console.error(error)
    res.status(error.status || 500).send({error: error.message})
  }
})

/// ////
/// Move Task ////
/// ////
app.patch('/tasks/:id/move', async (req, res) => {

  const task = await checkIfTaskIsEditable(req.params.id, req)
  
  const dt = (new Date).getTime()

  const alignSort = async () => {
    const tasks = await db.query('SELECT id, sort FROM tasks ORDER BY sort')
    for (let i = 0; i < tasks.rows.length; i++) {
      if (tasks[i].sort !== (i + 1) * 1000) {
        await db.query('UPDATE tasks SET sort=$1, updated_at=$2 WHERE id=$3', [(i + 1) * 1000, dt, tasks.rows[i].id])
      }
    }
  }

  const run = async (repeat) => {

    const beforeTask = await db.query('SELECT * FROM tasks WHERE id=$1', [req.body.beforeId])
    const sortMin = beforeTask.rows[0] ? beforeTask.rows[0].sort : 0
    const afterTask = await db.query('SELECT * FROM tasks WHERE sort>$1 AND id!=$2 ORDER BY sort LIMIT 1', [sortMin, task.id])
    const sortMax = afterTask.rows[0] ? afterTask.rows[0].sort : Math.ceil((sortMin + 1) / 1000) * 1000
    const sort = Math.floor((sortMin + sortMax) / 2)
    if (sort === sortMin || sort === sortMax) {
      if (repeat) {
        throw new RetroError('Unable to sort after align', 500)
      } else {
        await alignSort()
        await run(true)
      }
    } else {
      await db.query('UPDATE tasks SET sort=$1,col=$2,updated_at=$3 WHERE id=$4', [sort, req.body.col, dt, task.id])
      wssSendDt(dt)
      res.send()
    }
  }

  try {
    await run()
  } catch (error) {
    //console.error(error)
    res.status(error.status || 500).send({error: error.message})
  }
})

/// ////
/// Lock Record ////
/// ////
app.patch('/tasks/:id/lock', async (req, res) => {
  try {
    const task = await checkIfTaskIsEditable(req.params.id, req)
    console.log('task lock ok', task.id, req.headers['x-access-token'])
    const dt = (new Date).getTime()
    await db.query('UPDATE tasks SET locked_by=$1,locked_at=$2,updated_at=$3 WHERE id=$4', [req.headers['x-access-token'], dt, dt, task.id], (err, data) => {
      if (data) {
        wssSendDt(dt)
        res.send()
      }
    })
  } catch (error) {
    console.error(error)
    res.status(error.status || 500).send({error: error.message})
  }
})

/// ////
/// Unlock Record ////
/// ////
app.patch('/tasks/:id/unlock', async (req, res) => {
  try {
    const task = await db.query('SELECT * FROM tasks WHERE id=$1 AND deleted_at=0', [req.params.id])
    if (task.rows[0] && task.rows[0].locked_by === req.headers['x-access-token']) {
      const dt = (new Date).getTime()
      await db.query('UPDATE tasks SET locked_by=$1,locked_at=0,updated_at=$2 where id=$3', ['',dt, task.rows[0].id])  
      console.log('task unlock ok', task.id, req.headers['x-access-token'])
      wssSendDt(dt)
    }
    res.send()
  } catch (error) {

    console.error(error)
    res.status(error.status || 500).send({error: error.message})
  }
})

/// ////
/// Unlock Record ////
/// ////
app.patch('/tasks/:id/send_unlock_request', async (req, res) => {
  try {
    const [[task]] = await db.query('select * from tasks where id=$1 and deleted_at=0', [req.params.id])
    if (!task) {
      throw new RetroError('Task Not Found', 404)
    }
    if (!task.locked_by || task.locked_by === req.headers['x-access-token']) {
      throw new RetroError('The task is not locked', 400)
    }
    if (task.locking_switch_requested_by === req.headers['x-access-token']) {
      throw new RetroError('You have already asked for the edit permission', 400)
    }
    const dt = (new Date).getTime()
    await db.query('update tasks set locking_switch_requested_by=$1,locking_switch_requested_at=$2,updated_at=$3 where id=$4', [req.headers['x-access-token'], dt, dt, req.params.id])
    wssSendDt(dt)
    res.send()
  } catch (error) {
    console.error(error)
    res.status(error.status || 500).send({error: error.message})
  }
})

app.patch('/tasks/:id/cancel_unlock_request', async (req, res) => {
  try {
    const [[task]] = await db.query('select * from tasks where id=$1 and deleted_at=0', [req.params.id])
    if (!task) {
      throw new RetroError('Task Not Found', 404)
    }
    if (task.locking_switch_requested_by === req.headers['x-access-token']) {
      const dt = (new Date).getTime()
      await db.query('update tasks set locking_switch_requested_by="",locking_switch_requested_at=0,updated_at=$1 where id=$2', [dt, req.params.id])
      wssSendDt(dt)
    }
    res.send()
  } catch (error) {
    console.error(error)
    res.status(error.status || 500).send({error: error.message})
  }
})

app.patch('/tasks/:id/try_unlock', async (req, res) => {
  try {
    const [[task]] = await db.query('select * from tasks where id=$1 and deleted_at=0', [req.params.id])
    if (!task) {
      throw new RetroError('Task Not Found', 404)
    }
    if (task.locking_switch_requested_by === req.headers['x-access-token']) {
      const dt = (new Date).getTime()
      if (dt > task.locking_switch_requested_at + 5000) {
        await db.query(
          'update tasks set locking_switch_requested_by="",locking_switch_requested_at=0,locked_by=$1,locked_at=$2,updated_at=$3 where id=$4',
          [req.headers['x-access-token'], dt, dt, req.params.id]
        )
        wssSendDt(dt)
      } else {
        throw new RetroError('You have to wait for 5 seconds before getting the edit permission', 400)
      }
    } else {
      throw new RetroError('Someone else also asked for the edit permission, your request was cancelled', 400)
    }
    res.send()
  } catch (error) {
    console.error(error)
    res.status(error.status || 500).send({error: error.message})
  }
})

app.patch('/tasks/:id/deny_unlock', async (req, res) => {
  try {
    const task = await checkIfTaskIsEditable(req.params.id, req)
    const dt = (new Date).getTime()
    await db.query('update tasks set locking_switch_requested_by="",locking_switch_requested_at=0,updated_at=$1 where id=$2', [dt, task.id])
    wssSendDt(dt)
    res.send()
  } catch (error) {
    console.error(error)
    res.status(error.status || 500).send({error: error.message})
  }
})

app.patch('/tasks/:id/allow_unlock', async (req, res) => {
  try {
    const task = await checkIfTaskIsEditable(req.params.id, req)
    const dt = (new Date).getTime()
    await db.query('update tasks set locked_by=$1,locked_at=$2,locking_switch_requested_by="",locking_switch_requested_at=0,updated_at=$3 where id=$4', [dt.locking_switch_requested_by, dt, dt, task.id])
    wssSendDt(dt)
    res.send()
  } catch (error) {
    console.error(error)
    res.status(error.status || 500).send({error: error.message})
  }
})

server.listen(process.env.PORT)