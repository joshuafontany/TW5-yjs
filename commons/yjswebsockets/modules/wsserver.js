/*\
title: $:/plugins/commons/yjs/wsserver.js
type: application/javascript
module-type: library


\*/

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

if($tw.node) {
	const { uniqueNamesGenerator, adjectives, colors, animals, names } = require('./external/unique-names-generator/dist/index.js');
	const URL = require('url').URL;
	const WS = require('./external/ws/ws.js');
	const WebsocketSession = require('./wssession.js').WebsocketSession;
	const Y = require('./yjs.cjs');
	const CONFIG_API_TIDDLER = "$:/config/tiddlyweb/api";

/*
	A simple websocket server extending the `ws` library
	options: 
*/
function WebSocketServer(options) {
	Object.assign(this, new WS.Server(options));
	let self = this;
	// Setup the httpServer
	this.httpServer = options.httpServer || null;
	// Users
	this.anonId = 0; // Incremented when an anonymous userid is created
	// Setup a sessions Map
	$tw.sessions = new Map();
	// Set the event handlers
	this.on('listening',this.serverOpened);
	this.on('close',this.serverClosed);
	this.on('connection',this.handleWSConnection);
	// Add an api key to all wikis
	let tiddler = $tw.wiki.getTiddler(CONFIG_API_TIDDLER),
		newFields = {
			title: CONFIG_API_TIDDLER,
			text: tiddler && $tw.utils.uuid.validate(tiddler.fields.text) ? tiddler.fields.text : $tw.utils.uuid.v4()
		};
	$tw.wiki.addTiddler(new $tw.Tiddler(tiddler,newFields));
	// Set the binding
	$tw.syncadaptor.setYBinding($tw);
	$tw.states.forEach(function(state,pathPrefix) {
		// Setup the config api key.
		let tiddler = state.wiki.getTiddler(CONFIG_API_TIDDLER),
			newFields = {
				title: CONFIG_API_TIDDLER,
				text: tiddler && $tw.utils.uuid.validate(tiddler.fields.text) ? tiddler.fields.text : $tw.utils.uuid.v4()
			};
		state.wiki.addTiddler(new $tw.Tiddler(tiddler,newFields));
		// Set the binding
		state.syncadaptor.setYBinding(state);
	})
}

WebSocketServer.prototype = Object.create(require('./external/ws/ws.js').Server.prototype);
WebSocketServer.prototype.constructor = WebSocketServer;

WebSocketServer.prototype.defaultVariables = {

};

WebSocketServer.prototype.serverOpened = function() {

}

WebSocketServer.prototype.serverClosed = function() {

}

WebSocketServer.prototype.verifyUpgrade = function(request,options) {
	if(request.url.indexOf("wiki=") == -1 || request.url.indexOf("session=") == -1) {
		return false
	}
	// Compose the state object
	var state = {};
	state.wiki = options.wiki || $tw.wiki;
	state.boot = options.boot || $tw.boot;
	state.server = options.server;
	state.ip = request.headers['x-forwarded-for'] ? request.headers['x-forwarded-for'].split(/\s*,\s*/)[0]:
		request.connection.remoteAddress;
	state.serverAddress = this.httpServer.protocol + "://" + this.httpServer.address().address + ":" + this.httpServer.address().port;
	state.urlInfo = new URL(request.url,state.serverAddress);
	// Get the principals authorized to access this resource
	state.authorizationType = "readers";
	// Check whether anonymous access is granted
	state.allowAnon = state.server.isAuthorized(state.authorizationType,null);
	// Authenticate with the first active authenticator
	let fakeResponse = {
		writeHead: function(){},
		end: function(){}
	}
	if(state.server.authenticators.length > 0) {
		if(!state.server.authenticators[0].authenticateRequest(request,fakeResponse,state)) {
			// Bail if we failed (the authenticator will have -not- sent the response)
			return false;
		}	
	}
	// Authorize with the authenticated username
	if(!state.server.isAuthorized(state.authorizationType,state.authenticatedUsername)) {
		return false;
	}
	let session = this.getSession(state.urlInfo.searchParams.get("session")),
		requestKey = state.urlInfo.searchParams.get("wiki"),
		apiKey = state.wiki.getTiddlerText(CONFIG_API_TIDDLER,$tw.utils.uuid.NIL);
		if(state.authenticatedUsername == "Test") apiKey = $tw.utils.uuid.NIL;
	return !!session
		&& (requestKey, apiKey) == (apiKey, session.key)
		&& state.boot.pathPrefix == session.pathPrefix
		&& state.authenticatedUsername == session.authenticatedUsername
		&& state
};

/**
 * @param {WebSocket} socket
 * @param {UPGRADE} request
 * @param {$tw server state} state
	This function handles incomming connections from client sessions.
	It can support multiple client sessions, each with a unique sessionId.
	Session objects are defined in $:/plugins/commons/yjs/wssession.js
*/
WebSocketServer.prototype.handleWSConnection = function(socket,request,state) {
	let session = this.getSession(state.urlInfo.searchParams.get("session"));
	if(session) {		
		// Reset the connection state
		session.ip = state.ip;
		session.url = state.urlInfo;
		session.ws = socket;
		session.connecting = false;
		session.connected = true;
		session.synced = false;

		let wikiDoc = $tw.utils.getYDoc(session.pathPrefix);
		wikiDoc.sessions.set(session, new Set())
		$tw.utils.log(`['${session.username}'] Opened socket ${state.ip} (${request.connection.remoteAddress}) for Session ${session.id}`);
		// Event handlers
		socket.on('message', function(event) {
			wikiDoc.emit('message',[session,event]);
		});
		socket.on('close', function(event) {
			$tw.utils.log(`['${session.username}'] Closed socket ${state.ip} (${request.connection.remoteAddress}) for Session ${session.id}`);
			session.connecting = false;
			session.connected = false;
			session.synced = false;
			// Close the WikiDoc session when disconnected
			wikiDoc.emit('close',[session,event]);
			session.emit('disconnected', [{
				status: "disconnected",
				event: event 
			},session]);
		});

		session.emit('connected', [{status: "connected"},session]);
	}
}

/*
	User methods
*/
WebSocketServer.prototype.getAnonUsername = function(state) {
	// Query the request state server for the anon username parameter
	let anon = state.server.get("anon-username")
	return (anon || '') + uniqueNamesGenerator({
		dictionaries: [colors, adjectives, animals, names],
		style: 'capital',
		separator: '',
		length: 3,
		seed: this.anonId++
	});
}

/*
	Session methods
*/
WebSocketServer.prototype.newSession = function(options) {
	if(this.hasSession(options.id)) {
		return this.getSession(options.id);
	}
	if(options.id == $tw.utils.uuid.NIL) {
		options.id = $tw.utils.uuid.v4();
	}
	let session = new WebsocketSession(options);
	if(session) {
		this.setSession(session);
	}
	return session
}

WebSocketServer.prototype.setSession = function(session) {
	if(session.id !== $tw.utils.uuid.NIL) {
		return $tw.sessions.set(session.id,session);
	}
}

WebSocketServer.prototype.getSession = function(sessionId) {
	if(sessionId !== $tw.utils.uuid.NIL && this.hasSession(sessionId)) {
		return $tw.sessions.get(sessionId);
	} else {
		return null;
	}
}

WebSocketServer.prototype.hasSession = function(sessionId) {
	return $tw.sessions.has(sessionId);
}

WebSocketServer.prototype.deleteSession = function(sessionId) {
	if(this.hasSession(sessionId)) {
		this.getSession(sessionId).destroy()
		$tw.sessions.delete(sessionId);
	}
}

WebSocketServer.prototype.getSessionsByUser = function(username) {
	let usersSessions = new Map();
	for (let [id,session] of $tw.sessions.entries()) {
		if(session.username === username) {
			usersSessions.add(id,session);
		}
	}
	return usersSessions;
}

WebSocketServer.prototype.getSessionsByWiki = function(pathPrefix) {
	let wikiSessions = new Map();
	for (let [id, session] of $tw.sessions.entries()) {
		if(session.pathPrefix === pathPrefix) {
			wikiSessions.add(id, session);
		}
	}
	return wikiSessions;
}

/**
 * @param {WebsocketSession} session
 * @param {int} timeout
*/
WebSocketServer.prototype.refreshSession = function(session,timeout) {
	let eol = new Date(session.expires).getTime() + timeout;
	session.expires = new Date(eol).getTime();
}

exports.WebSocketServer = WebSocketServer;

}
