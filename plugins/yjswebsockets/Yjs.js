/*\
title: $:/plugins/commons/yjs/Yjs.js
type: application/javascript
module-type: library

A core prototype to hand everything else onto.

\*/

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

const WebsocketSession = require('./wssession.js').WebsocketSession;
const Y = require('./yjs.cjs');
const syncProtocol = require('./sync.cjs');
const authProtocol = require('./auth.cjs');
const awarenessProtocol = require('./awareness.cjs');
const time = require('./lib0/dist/time.cjs');
const encoding = require('./lib0/dist/encoding.cjs');
const decoding = require('./lib0/dist/decoding.cjs');
const mutex = require('./lib0/dist/mutex.cjs');
const map = require('./lib0/dist/map.cjs');
const { uniqueNamesGenerator, adjectives, colors, animals, names } = require('./external/unique-names-generator/dist/index.js');

// Polyfill because IE uses old javascript
if(!String.prototype.startsWith) {
  String.prototype.startsWith = function(search, pos) {
    return this.substr(!pos || pos < 0 ? 0 : +pos, search.length) === search;
  };
}

/*
  "TW5-yjs" is a Yjs and websocket module for both server and client/browser. 
*/
class YSyncer {
  constructor () {
    // disable gc when using snapshots!
    this.gcEnabled = $tw.node? (process.env.GC !== 'false' && process.env.GC !== '0'): true;
    // Create a logger
    this.logger = $tw.node? new $tw.utils.Logger("yjs-server"): new $tw.utils.Logger("yjs-browser");
    // Sessions
    this.sessions = new Map();
    // YDocs
    this.YDocs = new Map();
    /**
     * @type {{bindState: function(string,WSSharedDoc):void, writeState:function(string,WSSharedDoc):Promise<any>, provider: any}|null}
     */
    this.persistence = null;
  }

  /*
    Websocket Session methods
  */
  // Reconnect a session or create a new one
  openSession (options) {
    let session = this.getSession(options.id)
    if(!session || options.wikiName !== session.wikiName || options.username !== session.username) {
      if(options.id == this.uuid.NIL) {
        options.id = this.uuid.v4();
      }
      session = new WebsocketSession(options);
      this.sessions.set(options.id, session);
    }
    return session 
  }

  getSession (sessionId) {
    if(sessionId !== this.uuid.NIL && this.hasSession(sessionId)) {
      return this.sessions.get(sessionId);
    } else {
      return null;
    }
  }

  hasSession (sessionId) {
    return this.sessions.has(sessionId);
  }

  deleteSession (sessionId) {
    if (this.hasSession(sessionId)) {
      this.getSession(sessionId).destroy()
      this.sessions.delete(sessionId);
    }
  }

  /*
    Yjs methods
  */

  /**
   * Gets a Y.Doc by name, whether in memory or on disk
   *
   * @param {string} docname - the name of the Y.Doc to find or create
   * @param {boolean} gc - whether to allow gc on the doc (applies only when created)
   * @return {Y.Doc}
   */
  getYDoc (docname,gc = this.gcEnabled) {
    return map.setIfUndefined(this.YDocs, docname, () => {
      const doc = new WSSharedDoc(docname);
      doc.gc = gc;
      doc.name = docname;
      if (this.persistence !== null) {
        this.persistence.bindState(docname, doc);
      }
      this.YDocs.set(docname, doc);
      return doc;
    })
  }

}

exports.YSyncer = YSyncer;

// Y message handler flags
const messageSync = 0;
const messageAwareness = 1;
const messageAuth = 2;
const messageQueryAwareness = 3;
const messageHandshake = 4;
const messageHeartbeat = 5;

/**
 * @param {Uint8Array} update
 * @param {wssession} origin
 * @param {WSSharedDoc} doc
 */
const updateHandler = (update, origin, doc) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeUpdate(encoder, update)
  doc.sessions.forEach((_, s) => {
    if (origin !== s.id) {
      s.send(encoder,doc.name);
    }
  })
}

class WSSharedDoc extends Y.Doc {
  /**
   * @param {string} name
   */
  constructor (name) {
    super({ gc: $tw.Yjs.gcEnabled })
    this.name = name
    if($tw.node){
      this.mux = mutex.createMutex()
      /**
       * Maps from session to set of controlled user ids. Delete all user ids from awareness when this session is closed
       * @type {Map<Object, Set<number>>}
       */
      this.sessions = new Map()
      /**
       * @type {awarenessProtocol.Awareness}
       */
      this.awareness = new awarenessProtocol.Awareness(this)
      this.awareness.setLocalState(null)
      /**
       * @param {{ added: Array<number>, updated: Array<number>, removed: Array<number> }} changes
       * @param {Object | null} origin Origin is the connection that made the change
       */
      const awarenessChangeHandler = ({ added, updated, removed }, origin) => {
        const changedClients = added.concat(updated, removed)
        if (origin !== null) {
          const connControlledIDs = /** @type {Set<number>} */ (this.sessions.get(origin))
          if (connControlledIDs !== undefined) {
            added.forEach(clientID => { connControlledIDs.add(clientID) })
            removed.forEach(clientID => { connControlledIDs.delete(clientID) })
          }
        }
        // broadcast awareness update
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageAwareness)
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients))
        this.sessions.forEach((_, s) => {
          s.send(encoder,this.name);
        })
      }
      this.awareness.on('update', awarenessChangeHandler)
      this.on('update', updateHandler)
    }
  }
}

/*
* Node classes
*/ 
if($tw.node) {
const path = require('path');
const fs = require('fs');
const os = require('os');

// A polyfilL to make this work with older node installs

// START POLYFILL
const reduce = Function.bind.call(Function.call, Array.prototype.reduce);
const isEnumerable = Function.bind.call(Function.call, Object.prototype.propertyIsEnumerable);
const concat = Function.bind.call(Function.call, Array.prototype.concat);
const keys = Reflect.ownKeys;

if (!Object.values) {
  Object.values = function values(O) {
    return reduce(keys(O), (v, k) => concat(v, typeof k === 'string' && isEnumerable(O, k) ? [O[k]] : []), []);
  };
}
// END POLYFILL

class YServer extends YSyncer {
  constructor () {
    super();
    // Users
    this.anonId = 0; // Incremented when an anonymous userid is created

    // YDocs
    if (typeof persistenceDir === 'string') {
      console.info('Persisting Y documents to "' + persistenceDir + '"')
      // @ts-ignore
      const LeveldbPersistence = require('y-leveldb').LeveldbPersistence
      const ldb = new LeveldbPersistence(persistenceDir)
      this.persistence = {
        provider: ldb,
        bindState: async (docName, ydoc) => {
          const persistedYdoc = await ldb.getYDoc(docName)
          const newUpdates = Y.encodeStateAsUpdate(ydoc)
          ldb.storeUpdate(docName, newUpdates)
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc))
          ydoc.on('update', update => {
            ldb.storeUpdate(docName, update)
          })
        },
        writeState: async (docName, ydoc) => {}
      }
    }
  }

  /*
    Session methods
  */
  getAnonUsername (state) {
    // Query the request state server for the anon username parameter
    let anon = state.server.get("anon-username")
    return (anon || '') + uniqueNamesGenerator({
      dictionaries: [colors, adjectives, animals, names],
      style: 'capital',
      separator: '',
      length: 3,
      seed: $tw.Yjs.anonId++
    });
  }

  getSessionsByUser (username) {
    let usersSessions = new Map();
    for (let [id,session] of this.sessions.entries()) {
      if (session.username === username) {
        usersSessions.add(id,session);
      }
    }
    return usersSessions;
  }

  getSessionsByWiki (wikiName) {
    let wikiSessions = new Map();
    for (let [id, session] of this.sessions.entries()) {
      if (session.wikiName === wikiName) {
        wikiSessions.add(id, session);
      }
    }
    return wikiSessions;
  }

  /**
   * @param {WebsocketSession} session
   * @param {int} timeout
   */
  refreshSession (session,timeout) {
    if($tw.node && $tw.Yjs.wsServer) {
      let eol = new Date(session.expires).getTime() + timeout;
      session.expires = new Date(eol).getTime();
    }
  }

  /**
   * @param {WebSocket} socket
   * @param {UPGRADE} request
   * @param {$tw server state} state
    This function handles incomming connections from client sessions.
    It can support multiple client sessions, each with a unique sessionId.
    Session objects are defined in $:/plugins/commons/yjs/wssession.js
  */
  handleWSConnection (socket,request,state) {
    if($tw.Yjs.hasSession(state.sessionId)) {
      let session = $tw.Yjs.getSession(state.sessionId);
      // Reset the connection state
      session.ip = state.ip;
      session.url = state.urlInfo;
      session.ws = socket;
      session.connecting = false;
      session.connected = true;
      session.synced = false;
  
      let wikiDoc = $tw.Yjs.getYDoc(session.wikiName);
      wikiDoc.sessions.set(session, new Set())
      console.log(`['${state.sessionId}'] Opened socket ${socket._socket._peername.address}:${socket._socket._peername.port}`);
      // Event handlers
      socket.on('message', function(event) {
        let message = new Uint8Array(event);
        const decoder = session.authenticateMessage(message);
        if(message && decoder) {
          session.lastMessageReceived = time.getUnixTime();
          const encoder = encoding.createEncoder();
          const eventDoc = session.getSubDoc(decoding.readAny(decoder));
          const messageType = decoding.readVarUint(decoder);
          switch (messageType) {
            case messageSync: {
              encoding.writeVarUint(encoder, messageSync)
              // Instead of syncProtocol.readSyncMessage(decoder, encoder, eventDoc, null)
              // Implement Read-Only Sessions
              const messageSyncType = decoding.readVarUint(decoder);
              switch (messageSyncType) {
                case syncProtocol.messageYjsSyncStep1:
                  syncProtocol.readSyncStep1(decoder, encoder, eventDoc)
                  break
                case syncProtocol.messageYjsSyncStep2:
                  if (!session.isReadOnly) syncProtocol.readSyncStep2(decoder, eventDoc, session.id)
                  break
                case syncProtocol.messageYjsUpdate:
                  if (!session.isReadOnly) syncProtocol.readUpdate(decoder, eventDoc, session.id)
                  break
                default:
                  throw new Error('Unknown message type')
              }
              if (encoding.length(encoder) > 1) { 
                session.send(encoder,eventDoc.name);
              }
              break
            }
            case messageAwareness: {
              awarenessProtocol.applyAwarenessUpdate(wikiDoc.awareness,decoding.readVarUint8Array(decoder),session)
              break
            }
            case messageAuth : {
              break
            }
            case messageQueryAwareness : {
              break
            }
            case messageHandshake : {
              console.log(`['${session.id}'] Server Handshake`);
              // Refresh the session to expire in 60 minutes
              $tw.Yjs.refreshSession(session,1000*60*60);
              // send messageHandshake
              const encoderHandshake = encoding.createEncoder();
              encoding.writeVarUint(encoderHandshake, messageHandshake);
              encoding.writeVarString(encoderHandshake, JSON.stringify({
                expires: session.expires
              }));
              session.send(encoderHandshake,wikiDoc.name);
              // Start a sync
              // send sync step 1
              const encoderSync = encoding.createEncoder()
              encoding.writeVarUint(encoderSync, messageSync)
              syncProtocol.writeSyncStep1(encoderSync, wikiDoc)
              session.send(encoderSync,wikiDoc.name);
              // broadcast the doc awareness states
              const awarenessStates = wikiDoc.awareness.getStates()
              if (awarenessStates.size > 0) {
                const encoderAwareness = encoding.createEncoder()
                encoding.writeVarUint(encoderAwareness, messageAwareness)
                encoding.writeVarUint8Array(encoderAwareness, awarenessProtocol.encodeAwarenessUpdate(wikiDoc.awareness, Array.from(awarenessStates.keys())))
                session.send(encoderAwareness,wikiDoc.name);
              }
              // Notify listeners
              session.emit('handshake');
              break
            }
            case messageHeartbeat : {
              // ping == 0, pong == 1
              const heartbeatType = decoding.readVarUint(decoder)
              if(heartbeatType == 0) {
                // incoming ping, send back a pong
                const encoderHeartbeat = encoding.createEncoder()
                encoding.writeVarUint(encoderHeartbeat, messageHeartbeat)
                encoding.writeVarUint(encoderHeartbeat, 1)
                session.send(encoderHeartbeat,wikiDoc.name);
              } else if (heartbeatType == 1) {
                // Incoming pong, who did we ping?
              }
              break
            }
            default: {
              console.error(`['${session.id}'] Unable to compute message, ydoc ${message.doc}`);
            }
          }
        } else {
          console.error(`['${session.id}'] Unable to parse message:`, event);
          // send messageAuth denied
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, messageAuth);
          authProtocol.writePermissionDenied(encoder, "WebSocket Authentication Error - Invalid Client Message");
          session.send(encoder,wikiDoc.name);
          session.ws.close(4023, `Invalid session`);
        }
      });
      socket.on('close', function(event) {
        console.log(`['${session.id}'] Closed socket ${socket._socket._peername.address}:${socket._socket._peername.port}  (code ${socket._closeCode})`);
        session.connecting = false;
        session.connected = false;
        session.synced = false;
        // Close the WSSharedDoc session when disconnected
        $tw.Yjs.closeWSConnection(wikiDoc,session,event);
        session.emit('disconnected', [{
          event: event 
        },session]);
      });
      socket.on('error', function(error) {
        console.log(`['${session.id}'] socket error:`, error);
        $tw.Yjs.closeWSConnection(wikiDoc,session,event);
        session.emit('error', [{
          error: error
        },session]);
      })

      session.emit('connected', [{},session]);
    }
  }

  /**
   * @param {WSSharedDoc} doc
   * @param {WebsocketSession} session
   */
  closeWSConnection (doc,session,event) {
    if (doc.sessions.has(session)) {
      /**
       * @type {Set<number>}
       */
      // @ts-ignore
      const controlledIds = doc.sessions.get(session)
      doc.sessions.delete(session)
      awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null)
      if (doc.sessions.size === 0 && this.persistence !== null) {
        // if persisted, we store state and destroy ydocument
        this.persistence.writeState(doc.name, doc).then(() => {
          doc.destroy()
        })
        this.ydocs.delete(doc.name)
      }
    }
    if (session.isReady()) {
      session.ws.close(1000, `['${this.id}'] Websocket closed by the server`,event);
    }
  }
}

exports.YServer = YServer;
}