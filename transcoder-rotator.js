require('dotenv').config();
const fs = require('fs');
const _ = require('lodash');
const axios = require('axios');
const request = require('request');
const winston = require('winston');
const express = require('express');
const https = require('https');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const bodyParser = require('body-parser');

const ENV = process.env;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

logger.add(new winston.transports.Console({
  format: winston.format.simple()
}));

const vaultOptions = {
  apiVersion: 'v1',
  endpoint: 'https://env.cue.dj:8200',
  token: fs.readFileSync(ENV.VAULT_TOKEN, 'utf8').trim()
};

const Vault = require('node-vault')(vaultOptions);

Vault.read('secret/env').then(vault => {
  const secrets = vault.data;
  const SERVICE_KEY = secrets.service_key;

  const api = axios.create({
    baseURL: 'https://api.digitalocean.com/',
    responseType: 'json',
    crossDomain: true
  });

  axios.defaults.headers.common.Authorization = secrets.digitalocean_key;

  const MINIMUM_DROPLETS = 1;
  const TIME_TIL_RESET = 60000 * 60 * 3;
  const HEALTH_MEM_THRESHOLD = 25;
  const HEALTH_CPU_THRESHOLD = 80;

  let init = false;
  let initializing = false;
  let initialized = true;
  let clearInitialization = false;
  let availableDroplets = [];
  let serverPromises = [];

  let healthy = [];
  let unhealthy = [];
  let utilized = [];
  let flushing = [];

  let currentTranscoder = null;
  let activeTranscoders = [];

  function checkNewDroplet(droplet) {
    initializing = false;
    initialized = false;
    if (clearInitialization) {
      clearInterval(clearInitialization);
      clearInitialization = false;
    }

    const initializationChecker = setInterval(() => {
      const found = _.find(availableDroplets, (drop) => drop.id === droplet.id);
      if (found) {
        if (found.networks.v4.length > 0) {
          const ip = found.networks.v4[0].ip_address;
          console.log('GOT DROPLET IP', ip);
          request(`http://${ ip }:8080/health`, { json: true }, (err, response, body) => {
            if (body) {
              initialized = true;
              initializing = droplet.id;
              clearInitialization = setTimeout(() => {
                initializing = false;
              }, 60000 * 5);
              console.log('CLEARING CHECKER');
              clearInterval(initializationChecker);
            }
          });
        }
      }
    }, 5000);

    setTimeout(() => {
      if (!initializing && availableDroplets.length > MINIMUM_DROPLETS) {
        api.delete(`v2/droplets/${ droplet.id }`)
        .then(() => console.log(`DESTROYED DEAD DROPLET ${ droplet.id }`));
        clearInterval(initializationChecker);
        initialized = true;
      }
    }, 60000 * 5);
  }

  function createDroplet() {
    console.log('CREATING DROPLET');
    initializing = true;
    api.post('v2/droplets',
    {
      name: 'transcoder',
      region: 'nyc1',
      size: 's-1vcpu-1gb',
      image: '49860612',
      ssh_keys: ['20298220', '20398405'],
      backups: 'false',
      ipv6: false,
      user_data: '#cloud-config\nruncmd:\n - /opt/transcoder-controls/liquidsoap /opt/transcoder-controls/transcoder.liq\n - /usr/bin/git -C /opt/transcoder-controls pull origin master\n - /root/.nvm/versions/node/v8.12.0/bin/forever start /opt/transcoder-controls/index.js',
      private_networking: null,
      monitoring: false,
      volumes: null,
      tags: ['liquidsoap']
    }).then((res) => {
      console.log('CREATED!', res.data.droplet);
      checkNewDroplet(res.data.droplet);
    })
    .catch((err) => {
      console.log('ERROR CREATING DROPLET', err);
      initializing = false;
    });
  }

  function deleteDroplet(droplet) {
    api.delete(`v2/droplets/${ droplet }`)
    .then((res) => { console.log('DROPLET DELETED', droplet); })
    .catch(err => {});
  }

  // api.get('v2/load_balancers', (res) => console.log(res));
  logger.info(`INITIALIZING TRANSCODER ROTATOR WITH: ${ MINIMUM_DROPLETS } MINIMUM DROPLETS`);

  // Load monitor
  setInterval(() => {
      api.get('v2/droplets?tag_name=liquidsoap')
      .then(res => {
        if (res.data) {
          if (res.data.id !== 'service_unavailable') {
            availableDroplets = res.data.droplets;
          }

          // Run check one at a time, and while not initializing new droplet
          if (serverPromises.length === 0 && initialized) {
            // Gather health of all droplets
            for (let i = 0; i < availableDroplets.length; i++) {
              // console.log('available loop', availableDroplets[i].networks.v4);
              if (availableDroplets[i].networks.v4[0]) {
                const ip = availableDroplets[i].networks.v4[0].ip_address;
                serverPromises.push(
                  new Promise((resolve, reject) => {
                    request(`http://${ ip }:8080/health`, { json: true }, (err, response, body) => {
                      if (body) {
                        body.droplet = availableDroplets[i].id;
                        body.ip = ip;
                        resolve(body);
                      } else {
                        reject(err);
                      }
                    });
                  }).catch(err => {})
                );
              }
            }

            Promise.all(serverPromises).then((values) => {
              let deleting = false;
              if (values) {
                const newHealthy = [];
                const newUnhealthy = [];
                for (let i = 0; i < values.length; i++) {
                  if (values[i] && values[i].usage) {
                    if (values[i].usage < HEALTH_MEM_THRESHOLD) newHealthy.push(values[i]);
                    else newUnhealthy.push(values[i]);
                  }
                }

                healthy = newHealthy;
                unhealthy = newUnhealthy;

                // Initialize first transcoder
                if (!init || !currentTranscoder) {
                  currentTranscoder = values[0];
                  if (currentTranscoder) {
                    utilized.push(currentTranscoder.droplet);
                  }

                  init = true;
                }

                // Push new unhealthy droplets to flushing state
                for (let i = 0; i < unhealthy.length; i++) {
                  const exists = _.find(flushing, droplet => unhealthy[i].droplet === droplet.droplet);
                  if (!exists) {
                    flushing.push(unhealthy[i]);
                    request({
                      url: `http://${ unhealthy[i].ip }:8080/stop_liquidsoap`,
                      method: 'POST',
                      json: {
                        jwt: jwt.sign({
                          ttr: TIME_TIL_RESET
                        }, SERVICE_KEY)
                      }
                    }, (err, response, body) => {
                      if (body && body.success) {
                        console.log('FLUSHING!', unhealthy[i].droplet);
                        const compare = unhealthy[i];
                        setTimeout(() => {
                          if (compare) {
                            request({
                              url: `http://${ compare.ip }:8080/start_liquidsoap`,
                              method: 'POST',
                              json: {
                                jwt: jwt.sign({}, SERVICE_KEY)
                              }
                            }, (err, response, body) => {
                              flushing = flushing.filter(droplet => droplet.droplet !== compare.droplet);
                              utilized = utilized.filter(droplet => droplet !== compare.droplet);
                              console.log('TRANSCODER RESTORED!', compare.droplet);
                            });
                          }
                        }, TIME_TIL_RESET + 5000);
                      }
                    });
                  }
                }

                console.log('HEALTHY', healthy);
                console.log('UNHEALTHY', unhealthy);
                console.log('FLUSHING', flushing);
                console.log('UTILIZED', utilized);

                // If current transcoder becomes unhealthy, select new transcoding droplet
                const currentIsUnhealthy = _.find(unhealthy, droplet => droplet.droplet === currentTranscoder.droplet);
                if (currentIsUnhealthy || availableDroplets.length < MINIMUM_DROPLETS) {
                  let newCurrent;
                  for (let i = 0; i < healthy.length; i++) {
                    const exists = _.find(flushing, droplet => droplet.droplet === healthy[i].droplet);
                    console.log('EXISTS', exists);
                    if (!exists) {
                      newCurrent = healthy[i];
                    }
                  }

                  console.log('CHECKING STATE', newCurrent, initializing);
                  if (newCurrent) {
                    currentTranscoder = newCurrent;
                    utilized.push(currentTranscoder.droplet);
                  } else if (!initializing) {
                    // If all are unhealthy, spin up new transcoder droplet
                    createDroplet();
                  }
                }

                // Delete unused droplets
                if (healthy.length + unhealthy.length > MINIMUM_DROPLETS && healthy.length > 1) {
                  for (let i = 0; i < healthy.length; i++) {
                    const exists = _.find(utilized, droplet => droplet === healthy[i].droplet);
                    if (!exists && healthy[i].ip !== '162.243.166.194') {
                      console.log('DELETING', healthy[i].droplet);
                      deleteDroplet(healthy[i].droplet);
                    }
                  }
                }

                // Stop dead transcoders
                const now = new Date().getTime();
                activeTranscoders.forEach(transcoder => {
                  if (now > transcoder.cleanup.getTime()) {
                    console.log('REMOVING DEAD TRANSCODER', transcoder.ip, transcoder.public);
                    request({
                      url: `http://${ transcoder.ip }:8080/stop`,
                      method: 'POST',
                      json: {
                        jwt: jwt.sign({
                          stream: {
                            public: transcoder.public
                          }
                        }, SERVICE_KEY)
                      }
                    }, (err, response, body) => {
                      activeTranscoders = activeTranscoders.filter(search => search.public !== transcoder.public);
                    });
                  }
                });

                console.log('CURRENT TRANSCODER :', currentTranscoder);
                console.log('ACTIVE TRANSCODERS :', activeTranscoders);
              }

              serverPromises = [];
            });
          }
        }
      })
      .catch(err => { console.log('GOT ERROR', err); });
  }, 10000);


  function notifyFirstSet(room, dj) {
    request({
        url: `${ secrets.service_notifications }/firstSet`,
        method: 'POST',
        json: { jwt: jwt.sign({ room, dj }, SERVICE_KEY) }
    }, (err, response, body) => {
        if (body) {
            console.log('FIRST SET NOTIFICATION');
        } else {
            console.log('FIRST SET ISSUE');
        }
    });
  }

  function notifyLiveSet(room) {
    request({
        url: `${ secrets.service_notifications }/liveSet`,
        method: 'POST',
        json: { jwt: jwt.sign({ room }, SERVICE_KEY) }
    }, (err, response, body) => {
        if (body) {
            console.log('LIVE SET NOTIFICATION');
        } else {
            console.log('LIVE SET ISSUE');
        }
    });
  }

  function verify(token, res, callback) {
    try {
        const verified = jwt.verify(token.jwt, SERVICE_KEY);
        return callback(verified);
    } catch (err) {
        return res.status(500).json('Authorization error');
    }
  }

  const app = express();
  app.use(cors());
  app.use(bodyParser.json());

  app.get('/current', (req, res) => {
    res.json(currentTranscoder);
  });

  app.get('/status', (req, res) => {
    res.json({
      healthy,
      unhealthy,
      flushing,
      currentTranscoder
    });
  });

  app.post('/start', (req, res) => {
    verify(req.body, res, (data) => {
      const pub = data.room.url;
      const priv = data.room.private;

      const exists = activeTranscoders.find((transcoder) => {
        return transcoder.public === pub;
      });

      if (exists) {
        exists.cleanup = new Date(new Date().getTime() + TIME_TIL_RESET);
        return res.json({ success: `TRANSCODER ${ pub } EXISTS, CLEANUP REFRESHED` });
      }

      return request({
        url: `http://${ currentTranscoder.ip }:8080/start`,
        method: 'POST',
        json: {
          jwt: jwt.sign({
            stream: { public: pub, private: priv }
          }, SERVICE_KEY)
        }
      }, (err, response, body) => {
        if (body) {
          activeTranscoders.push({
              ip: currentTranscoder.ip,
              public: pub,
              private: priv,
              cleanup: new Date(new Date().getTime() + TIME_TIL_RESET)
          });

          if (data.env !== 'development') {
            notifyFirstSet(data.room._id, data.room.dj);
            notifyLiveSet(data.room);
          }
          console.log(`TRANSCODER STARTED FOR ${ pub }`);
          return res.json({ success: `TRANSCODER STARTED FOR ${ pub }` });
        }

        console.log(`ISSUE STARTING TRANSCODER ON ${ currentTranscoder.ip }`);
        return res.status(409).json({ error: `ISSUE STARTING TRANSCODER ON ${ currentTranscoder.ip }` });
      });
    });
  });

  app.post('/startTest', (req, res) => {
    verify(req.body, res, (data) => {
      const pub = data.stream.public;
      const priv = data.stream.private;

      const exists = activeTranscoders.find((transcoder) => {
        return transcoder.public === pub;
      });

      if (exists) {
        exists.cleanup = new Date(new Date().getTime() + TIME_TIL_RESET);
        return res.json({ success: `TRANSCODER ${ pub } EXISTS, CLEANUP REFRESHED` });
      }

      return request({
        url: `http://${ currentTranscoder.ip }:8080/start`,
        method: 'POST',
        json: {
          jwt: jwt.sign({
            stream: { public: pub, private: priv }
          }, SERVICE_KEY)
        }
      }, (err, response, body) => {
        if (body) {
          activeTranscoders.push({
              ip: currentTranscoder.ip,
              public: pub,
              private: priv,
              cleanup: new Date(new Date().getTime() + TIME_TIL_RESET)
          });

          console.log(`TRANSCODER STARTED FOR ${ pub }`);
          return res.json({ success: `TRANSCODER STARTED FOR ${ pub }` });
        }

        console.log(`ISSUE STARTING TRANSCODER ON ${ currentTranscoder.ip }`);
        return res.status(409).json({ error: `ISSUE STARTING TRANSCODER ON ${ currentTranscoder.ip }` });
      });
    });
  });

  app.post('/stop', (req, res) => {
    verify(req.body, res, (data) => {
      const findIP = activeTranscoders.find((transcoder) => {
          return transcoder.public === data.stream.public;
      });

      if (findIP) {
        return request({
          url: `http://${ findIP.ip }:8080/stop`,
          method: 'POST',
          json: {
            jwt: jwt.sign({
              stream: data.stream,
            }, SERVICE_KEY)
          }
        }, (err, response, body) => {
          if (body) {
            activeTranscoders = activeTranscoders.filter(transcoder => transcoder.public !== data.stream.public);
            console.log(`TRANSCODER STOPPED FOR ${ data.stream.public }`);
            res.json({ success: `TRANSCODER STOPPED FOR ${ data.stream.public }` });
          } else {
            console.log(`ISSUE STOPPING TRANSCODER ON ${ currentTranscoder.ip }`);
            res.status(409).json({ error: `ISSUE STOPPING TRANSCODER ON ${ currentTranscoder.ip }` });
          }
        });
      }

      return res.json({ success: `TRANSCODER ${ data.stream.public } NOT FOUND` });
    });
  });

  const options = {
      key:  fs.readFileSync(`${ ENV.CERT_LOCATION }/privkey.pem`, 'utf8'),
      cert: fs.readFileSync(`${ ENV.CERT_LOCATION }/fullchain.pem`, 'utf8')
  };
  const server = https.createServer(options, app);
  server.listen(2222);
});
