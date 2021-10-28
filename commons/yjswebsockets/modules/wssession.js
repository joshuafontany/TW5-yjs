/*\
title: $:/plugins/commons/yjs/wssession.js
type: application/javascript
module-type: library

A Yjs powered websocket session model.

\*/

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

/*
Reference Yjs y-websocket.cjs

Unlike stated in the LICENSE file, it is not necessary to include the copyright notice and permission notice when you copy code from this file.
*/

Object.defineProperty(exports, '__esModule', {
	value: true
});

const WS = $tw.node ? require('./external/ws/ws.js') : WebSocket;
require('./yjs.cjs');
const syncProtocol = require('./sync.cjs');
const authProtocol = require('./auth.cjs');
const awarenessProtocol = require('./awareness.cjs');
const time = require('./lib0/dist/time.cjs');
const encoding = require('./lib0/dist/encoding.cjs');
const decoding = require('./lib0/dist/decoding.cjs');
const observable_js = require('./lib0/dist/observable.cjs');
const math = require('./lib0/dist/math.cjs');
const random = require('./lib0/dist/random.cjs');

// Y message handler flags
const messageSync = 0;
const messageAwareness = 1;
const messageAuth = 2;
const messageQueryAwareness = 3;
const messageHandshake = 4;
const messageHeartbeat = 5;

/**
 *                       encoder,          decoder,          session,          emitSynced, messageType
 * @type {Array<function(encoding.Encoder, decoding.Decoder, WebsocketSession, boolean,    number):void>}
 */
const messageHandlers = [];

messageHandlers[messageSync] = (encoder, decoder, session, doc, emitSynced, messageType) => {
	encoding.writeVarUint(encoder, messageSync);
	const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, doc, session);
	if(emitSynced && syncMessageType === syncProtocol.messageYjsSyncStep2 && !session.synced) {
		session.synced = true;
	}
};

messageHandlers[messageAwareness] = (encoder, decoder, session, doc, emitSynced, messageType) => {
	awarenessProtocol.applyAwarenessUpdate(session.awareness, decoding.readVarUint8Array(decoder), session);
};

messageHandlers[messageAuth] = (encoder, decoder, session, doc, emitSynced, messageType) => {
	authProtocol.readAuthMessage(decoder, session, permissionDeniedHandler);
};

messageHandlers[messageQueryAwareness] = (encoder, decoder, session, doc, emitSynced, messageType) => {
	encoding.writeVarUint(encoder, messageAwareness);
	encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(session.awareness, Array.from(session.awareness.getStates().keys())));
};

messageHandlers[messageHandshake] = (encoder, decoder, session, doc, emitSynced, messageType) => {
	let handshakeData = JSON.parse(decoding.readVarString(decoder));
	// Set the session expiration
	session.expires = handshakeData.expires;
	session.settings = $tw.wiki.getTiddlerData("$:/config/commons/yjs/wssession", {});
	// Start a heartbeat
	session.heartbeat();
	// Start a sync
	session.logger.log(`Client Handshake for Session ${session.id};`);
	// send sync step 1
	const encoderSync = encoding.createEncoder()
	encoding.writeVarUint(encoderSync, messageSync)
	syncProtocol.writeSyncStep1(encoderSync, doc)
	session.send(encoderSync, session.key);
	// broadcast local awareness state
	if(session.awareness.getLocalState() !== null) {
		const encoderAwarenessState = encoding.createEncoder();
		encoding.writeVarUint(encoderAwarenessState, messageAwareness);
		encoding.writeVarUint8Array(encoderAwarenessState, awarenessProtocol.encodeAwarenessUpdate(session.awareness, [session.doc.clientID]));
		session.send(encoderAwarenessState, session.key);
	}
	// Notify listeners
	session.emit('handshake',[session]);
};

messageHandlers[messageHeartbeat] = (encoder, decoder, session, doc, emitSynced, messageType) => {
	// ping == 0, pong == 1
	const heartbeatType = decoding.readVarUint(decoder)
	if(heartbeatType == 0) {
		// incoming ping, send back a pong
		const encoderHeartbeat = encoding.createEncoder()
		encoding.writeVarUint(encoderHeartbeat, messageHeartbeat)
		encoding.writeVarUint(encoderHeartbeat, 1)
		session.send(encoderHeartbeat, session.key);
	} else if(heartbeatType == 1) {
		// Incoming pong, setup a heartbeat
		session.heartbeat();
	}
};

/**
 * @param {WebsocketSession} session
 * @param {string} reason
 */
const permissionDeniedHandler = (session, reason) => session.logger.alert(`Permission denied to access ${session.url}.\n${reason}`);

/**
 * @param {WebsocketSession} session
 */
const setupWS = (session) => {
	if(session.shouldConnect && session.ws === null) {
		/**
		 * @type {any}
		 */
		session.ping = null;
		session.pingTimeout = null;
		/**
		 * @type {WebSocket}
		 */
		const websocket = new WS(session.url.href);
		websocket.binaryType = session.binaryType || 'arraybuffer';
		session.ws = websocket;
		session.connecting = true;
		session.connected = false;
		session.synced = false;

		websocket.onmessage = event => {
			let message;
			if(!!event.data) {
				message = new Uint8Array(event.data);
			} else {
				message = new Uint8Array(event);
			}
			const decoder = session.authenticateMessage(message);
			if(message && decoder) {
				session.lastMessageReceived = time.getUnixTime();
				const encoder = encoding.createEncoder();
				const eventDoc = session.getSubDoc(decoding.readAny(decoder));
				const messageType = decoding.readVarUint(decoder);
				const messageHandler = session.messageHandlers[messageType];
				if( /** @type {any} */ (messageHandler)) {
					messageHandler(encoder, decoder, session, eventDoc, true, messageType);
				} else {
					session.logger.alert(`Unable to compute message; WikiDoc '${message.doc.name}', Session '${session.id}';`);
				}
				if(encoding.length(encoder) > 1) {
					session.send(encoder, eventDoc.name);
				}
			} else {
				session.logger.alert(`Unable to parse message; WikiDoc '${message.doc.name}', Session '${session.id}';`,JSON.stringify(event,null,$tw.config.preferences.jsonSpaces));
				// send messageAuth denied
				const encoder = encoding.createEncoder();
				encoding.writeVarUint(encoder, messageAuth);
				authProtocol.writePermissionDenied(encoder, "WebSocket Authentication Error - Invalid Server Message");
				session.send(encoder, session.key);
				session.ws.close(4023, `Invalid session`);
			}
		};

		websocket.onclose = event => {
			session.logger.log(`Socket closed ${websocket.url}`);
			// Clear the ping timers
			clearTimeout(session.pingTimeout);
			clearTimeout(session.ping);
			// Handle the ws
			session.ws = null;
			session.connecting = false;
			if(session.connected) {
				session.connected = false;
				// update awareness (all users except local are null)
				awarenessProtocol.removeAwarenessStates(
					session.awareness,
					Array.from(session.awareness.getStates().keys()).filter(client => client !== session.doc.clientID),
					session
				);
			} else {
				session.unsuccessfulReconnects++;
			}
			// Test for 4023 code
			if(!session.settings.reconnect.auto || session.unsuccessfulReconnects > session.settings.reconnect.abort || event.code == 4023) {
				// Invalid session or connection rejected
				session.unsuccessfulReconnects = 0;
				session.synced = false;
			} else {
				// Start with a very small reconnect timeout and increase timeout by
				// Math.round(Math.random() * (base = 500) * Math.pow((decay = 1.5), session.unsuccessfulReconnects))
				let delay = math.min(
					math.round(random.rand() * session.settings.reconnect.base * math.pow(session.settings.reconnect.decay, session.unsuccessfulReconnects)),
					session.settings.reconnect.max
				);
				setTimeout(setupWS, delay, session);
			}
			session.emit('status', [{
				status: "disconnected",
				code: event.code,
				reason: event.reason
			}, session]);
		};

		websocket.onopen = () => {
			session.logger.log(`Opened socket ${websocket.url}`);
			// Reset connection state
			session.connecting = false;
			session.connected = true;
			session.unsuccessfulReconnects = 0;

			// send messageHandshake
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, messageHandshake);
			session.send(encoder, session.key);

			session.emit('status', [{status: "connected"}, session]);
		};

		session.emit('status', [{status: "connecting"}, session]);
	}
};

/**
 * @param {WebsocketSession} session
 */
const setupHeartbeat = (session) => {
	// Delay should be equal to the interval at which your server
	// sends out pings plus a conservative assumption of the latency (10s).  
	session.pingTimeout = setTimeout(function() {
		if(session.isReady()) {
			let lastMessage = new Date(session.lastMessageReceived*1000).toLocaleString();
			session.ws.close(4000, `Heartbeat Timeout`);
			session.logger.log(`Session closed by heartbeat, last message received at ${lastMessage}`);
		}
	}, session.settings.heartbeat.timeout + session.settings.heartbeat.interval);
	// Send the next heartbeat ping after session.settings.heartbeat.interval ms
	session.ping = setTimeout(function () {
		// ping == 0, pong == 1
		const encoderHeartbeat = encoding.createEncoder()
		encoding.writeVarUint(encoderHeartbeat, messageHeartbeat)
		encoding.writeVarUint(encoderHeartbeat, 0)
		session.send(encoderHeartbeat, session.key);
	}, session.settings.heartbeat.interval);
}

/**
 *  A Yjs powered websocket session model
 * @extends Observable<string>
 */
class WebsocketSession extends observable_js.Observable {
	/**
	 * @param {object} options
	 * @param {string} [options.id] A unique session id
	 * @param {string} [options.key] The "room key"
	 * @param {string} [options.pathPrefix] The "room name"
	 * @param {boolean} [options.connect]
	 * @param {awarenessProtocol.Awareness} [options.awareness]
	 * @param {boolean} [options.client] Is this a "client" session?
	 * @param {URL} [options.url]
	 * @param {'arraybuffer' | 'blob' | null} [opts.binaryType] Set `ws.binaryType`
	 * @param {string} [options.ip] The current IP address for the ws connection
	 * @param {string} [options.authenticatedUsername] The auth username, null for (anon)
	 * @param {string} [options.username] The display username
	 * @param {string} [options.access] The user-session's access level
	 * @param {boolean} [options.isLoggedIn] The user's login state
	 * @param {boolean} [options.isReadOnly] The User-session read-only state
	 * @param {boolean} [options.isAnonymous] The User's anon stat
	 * @param {object} logger A reference to the $tw.utils.Logger() to save to
	 */
	constructor(options,logger) {
		if(!options.id || !$tw.utils.uuid.validate(options.id) || options.id == $tw.utils.uuid.NIL) {
			throw new Error("WebsocketSession Error: invalid options.id provided in constructor.")
		}
		super();
		this.id = options.id; // Required $tw.utils.uuid.v4()
		this.key = options.key; // Required $tw.utils.uuid.v4()
		this.pathPrefix = options.pathPrefix;
		this.authenticatedUsername = options.authenticatedUsername;
		this.username = options.username;
		this.isAnonymous = options.isAnonymous;
		this.isLoggedIn = options.isLoggedIn;
		this.isReadOnly = options.isReadOnly;
		this.access = options.access;
		this.client = !!options.client;
		this.logger = new $tw.utils.Logger(`[${this.pathPrefix}|'${this.username}']`,{colour: "green"});
		(!!logger) && this.logger.setSaveBuffer(logger.saveBufferLogger);

		/**
		 * @type {boolean}
		 */
		this._synced = false;
		/**
		 * @type {WebSocket?}
		 */
		this.ws = null; // The active websocket
		this.lastMessageReceived = 0;

		// Config
		this.binaryType = options.binaryType || "arraybuffer";
		this.expires = options.expires || time.getUnixTime();
		this.ip = options.ip;
		this.url = this.client ? this.getHostURL(options.url) : options.url;
		this.ping = null; // heartbeat
		this.pingTimeout = null; // heartbeat timeout
		this.connected = false;
		this.connecting = false;
		this.unsuccessfulReconnects = 0;
		this.messageHandlers = messageHandlers.slice();
		if(this.client) {
			let connect = typeof options.connect !== 'undefined' && typeof options.connect !== 'null' ? options.connect : true;
			/**
			 * Whether to connect to other peers or not
			 * @type {boolean}
			 */
			this.shouldConnect = connect;
			this.settings = $tw.wiki.getTiddlerData("$:/config/commons/yjs/wssession", {});
			this.doc = $tw.utils.getYDoc(this.key);
			let awareness = options.awareness || new awarenessProtocol.Awareness(this.doc); // Y.doc awareness

			// Browser features
			if($tw.browser) {
				// Awareness
				window.addEventListener('beforeunload', () => {
					awarenessProtocol.removeAwarenessStates(awareness, [this.doc.clientID], 'window unload');
				});
			}

			/**
			 * Listens to Yjs updates and sends them to remote peers
			 * @param {Uint8Array} update
			 * @param {any} origin
			 */
			this._updateHandler = (update, origin) => {
				if(origin !== this) {
					const encoder = encoding.createEncoder();
					encoding.writeVarUint(encoder, messageSync);
					syncProtocol.writeUpdate(encoder, update);
					this.send(encoder, this.doc.name);
				}
			};
			this.doc.on('update', this._updateHandler);
			/**
			 * @param {any} changed
			 * @param {any} origin
			 */
			this._awarenessUpdateHandler = ({
				added,
				updated,
				removed
			}, origin) => {
				const changedClients = added.concat(updated).concat(removed);
				const encoder = encoding.createEncoder();
				encoding.writeVarUint(encoder, messageAwareness);
				encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients));
				this.send(encoder, this.doc.name);
			};
			awareness.on('update', this._awarenessUpdateHandler);
			this.awareness = awareness;

			if(connect) {
				this.connect();
			}
		}
	}

	getSubDoc (docname = null) {
		if(this.client && docname == this.doc.name) {
			return this.doc;
		} else {
			return $tw.utils.getYDoc(docname);
		}
	}

	toJSON () {
		return {
			id: this.id,
			key: this.key,
			pathPrefix: this.pathPrefix,
			authenticatedUsername: this.authenticatedUsername,
			username: this.username,
			isAnonymous: this.isAnonymous,
			isLoggedIn: this.isLoggedIn,
			isReadOnly: this.isReadOnly,
			access: this.access,
			client: this.client,
			ip: this.ip,
			url: this.url.href || this.url.toString(),
			binaryType: this.binaryType,
			expires: this.expires
		};
	}

	/**
	 * @type {boolean}
	 */
	get synced() {
		return this._synced
	}

	set synced(state) {
		if(this._synced !== state) {
			this._synced = state;
			this.emit('sync', [state, this]);
		}
		this.emit('synced', [state, this]);
	}

	destroy () {
		// clear the ping timers
		clearTimeout(this.pingTimeout);
		clearTimeout(this.ping);
		this.disconnect();
		super.destroy();
	}

	disconnect (err) {
		if(this.client) {
			this.shouldConnect = false;
			if(this.isReady()) {
				this.ws.close(1000, `Session: ${this.id} closed by the client`, err);
			}
		} else {
			let wikiDoc = $tw.utils.getYDoc(this.key);
			wikiDoc.emit('close',[session,err]);
		}
		this.ws = null;
	}

	connect () {
		if(!this.client || !this.url) {
			this.logger.alert(`Session '${this.id}'' connect error: no client url`)
			return;
		}
		this.shouldConnect = true;
		if(!this.isReady()) {
			this.ws = null;
			setupWS(this);
		}
	}

	isReady () {
		return this.connected && !!this.ws && this.ws.readyState == 1;
	}

	getHostURL (host) {
		let url = $tw.node ? new require('url').URL(host) : new URL(host);
		// Websocket host
		url.protocol = url.protocol == "https:" ? "wss:" : "ws:";
		return url;
	}

	/**
	 * If a heartbeat is not received within session.settings.heartbeat.timeout from
	 * the last heartbeat, terminate the given socket. Setup the next heartbeat.
	 */
	heartbeat () {
		// clear the ping timers
		clearTimeout(this.pingTimeout);
		clearTimeout(this.ping);
		setupHeartbeat(this);
	}

	/**
	 * @param {BinaryEncoder} message
	 * @param {null|string} docid
	 */
	send (message, docid = null) {
		if(this.isReady()) {
			try {
				/**
				 * Y Messages are encoded as:
				 * this.id {string}
				 * docid {null|string}
				 * message {BinaryEncoder}
				 */
				let encoder = encoding.createEncoder();
				encoding.writeVarString(encoder, this.id);
				encoding.writeAny(encoder, docid);
				encoding.writeBinaryEncoder(encoder, message);
				this.ws.send(encoding.toUint8Array(encoder), err => {
					err != null && this.disconnect(err)
				});
			} catch (err) {
				this.disconnect(err);
			}
		}
	}

	/**
	 * Authenticates a message
	 *
	 * @param {Uint8Array} message - the current event data
	 * @return {decoder}
	 */
	authenticateMessage (message) {
		let expired = time.getUnixTime() > this.expires,
			decoder = decoding.createDecoder(message),
			authed = !expired && decoding.readVarString(decoder) == this.id;
		if(!authed) {
			this.logger.alert(`Session '${session.id}' authentication error` + expired ? `, session expired` : ``);
		}
		return authed ? decoder : null;
	}
}

exports.WebsocketSession = WebsocketSession;