/*\
title: $:/plugins/commons/yjs/commands/ws-listen.js
type: application/javascript
module-type: command

Serve tiddlers using a two-way websocket server over http

\*/

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

exports.info = {
  name: "ws-listen",
  synchronous: true,
	namedParameterMode: true,
	mandatoryParameters: []
};

const fs = require("fs"),
		path = require("path"),
    MultiServer = require('$:/plugins/commons/multiserver/multiserver.js').MultiServer,
    WebSocketServer = require('../server/wsserver.js').WebSocketServer;

const Command = function(params,commander,callback) {
  let self = this;
  this.params = params;
  this.commander = commander;
  this.callback = callback;
};

Command.prototype.execute = function() {
  if(!$tw.boot.wikiTiddlersPath) {
    $tw.utils.warning("Warning: Wiki folder '" + $tw.boot.wikiPath + "' does not exist or is missing a tiddlywiki.info file");
    return;
  }
  let self = this;
  // Set up http(s) server
  this.server = new MultiServer({
		wiki: this.commander.wiki,
    requiredPlugins: [
      "$:/plugins/commons/multiserver",
      "$:/plugins/commons/yjs",
      "$:/plugins/commons/yjswebsockets",
      "$:/plugins/tiddlywiki/filesystem"
    ].join(','),
		variables: self.params
	});
  // Set up the the WebSocketServer
  this.wsServer = new WebSocketServer({
    clientTracking: false, 
    noServer: true // We roll our own Upgrade,
  });
  // Verify the Upgrades
  verifyUpgrade = function(request) {debugger;
    if(request.url.indexOf("wiki=") !== -1
    && request.url.indexOf("session=") !== -1) {
      // Compose the state object
      var state = {};
      state.server = self.server;
      state.ip = request.headers['x-forwarded-for'] ? request.headers['x-forwarded-for'].split(/\s*,\s*/)[0]:
        request.connection.remoteAddress;
      state.serverAddress = self.server.protocol + "://" + self.server.httpServer.address().address + ":" + self.server.httpServer.address().port;
      state.urlInfo = new URL(request.url,state.serverAddress);
      //state.pathPrefix = request.pathPrefix || this.get("path-prefix") || "";
      // Get the principals authorized to access this resource
      var authorizationType = "readers";
      // Check whether anonymous access is granted
      state.allowAnon = self.server.isAuthorized(authorizationType,null);
      // Authenticate with the first active authenticator
      let fakeResponse = {
        writeHead: function(){},
        end: function(){}
      }
      if(self.server.authenticators.length > 0) {
        if(!self.server.authenticators[0].authenticateRequest(request,fakeResponse,state)) {
          // Bail if we failed (the authenticator will have -not- sent the response)
          return false;
        }		
      }
      // Authorize with the authenticated username
      if(!self.server.isAuthorized(authorizationType,state.authenticatedUsername)) {
        return false;
      }
      state.sessionId = state.urlInfo.searchParams.get("session");
      if($tw.Yjs.hasSession(state.sessionId)) {
        let session = $tw.Yjs.getSession(state.sessionId);
        return state.authenticatedUsername == session.authenticatedUsername
          && state.urlInfo.searchParams.get('wiki') == session.wikiName
          && state
      }
    } else {
      return false;
    }
  };
  // Listen
  let nodeServer = this.server.listen();
  nodeServer.on('upgrade', function(request,socket,head) {
    if(self.wsServer && request.headers.upgrade === 'websocket') {
      // Verify the client here
      let state = verifyUpgrade(request);
      if(state){
        self.wsServer.handleUpgrade(request,socket,head,function(ws) {
          self.wsServer.emit('connection',ws,request,state);
        });
      } else {
        $tw.utils.log(`ws-server: Unauthorized Upgrade GET ${request.url}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }
  });
  $tw.utils.log(`TiddlyWiki v${$tw.version} with TW5-Yjs Websockets`);
	$tw.hooks.invokeHook("th-server-command-post-start",this.server,nodeServer,"tiddlywiki");
  return null;
};

exports.Command = Command;