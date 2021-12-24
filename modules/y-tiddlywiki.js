/*\
title: y-tiddlywiki.js
type: application/javascript
module-type: library

A yjs binding connecting a Y.Doc to the current $tw.syncer

\*/

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

/**
 * @module bindings/tiddlywiki
 */
 const { Awareness } = require('y-protocols/dist/awareness.cjs');
 const { createMutex } = require('lib0/dist/mutex.cjs');
 const Delta = require('quilljs/delta');
 const Y = require('yjs');
 
 /**
  * @param {any} twCursors
  */
 const updateCursor = (twCursors, aw, clientId, doc, type) => {
   try {
	 if (aw && aw.cursor && clientId !== doc.clientID) {
	   const user = aw.user || {}
	   const color = user.color || '#ffa500'
	   const name = user.name || `User: ${clientId}`
	   twCursors.createCursor(clientId.toString(), name, color)
	   const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(aw.cursor.anchor), doc)
	   const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(aw.cursor.head), doc)
	   if (anchor && head && anchor.type === type) {
		 twCursors.moveCursor(clientId.toString(), { index: anchor.index, length: head.index - anchor.index })
	   }
	 } else {
	   twCursors.removeCursor(clientId.toString())
	 }
   } catch (err) {
	 console.error(err)
   }
 }
 
 class TiddlywikiBinding {
	/**
		* @param {Y.Doc} wikiDoc
		* @param {$tw.Syncer} syncer
		* @param {awareness} [awareness] optional
		*/
	constructor (wikiDoc,syncer,awareness) {
		if(!wikiDoc) throw new Error("TiddlywikiBinding Error: invalid wikiDoc provided in constructor.");
		if(!syncer) throw new Error("TiddlywikiBinding Error: sycner required.");

		this.logger = new $tw.utils.Logger("yjs")
		this.syncer = syncer
		
		// Find all fields that use $tw.utils.parseStringArray
		this.textFields = []
		$tw.utils.each($tw.Tiddler.fieldModules,(module,name) => {
			if(module.parse == $tw.utils.parseStringArray) {
				this.textFields.push(name)
			}
		});

		const mux = createMutex()
		this.mux = mux

		// Initialize the WikiDoc by applying the schema, and bind it to $tw
		this.wikiDoc = wikiDoc

		const wikiTiddlers = wikiDoc.getArray("tiddlers")
		this.wikiTiddlers = wikiTiddlers

		this.wikiTitles = wikiDoc.getArray("titles") 
		this.wikiTombstones = wikiDoc.getArray("tombstones")

		const twCursors = null //quill.getModule('cursors') || null
		this.twCursors = twCursors
		this._setAwareness = (awareness) => {
			this.awareness = awareness
			if (this.awareness && twCursors) {
				// init remote cursors
				this.awareness.getStates().forEach((aw, clientId) => {
					updateCursor(twCursors, aw, clientId, wikiDoc, wikiTiddlers)
				})
				this.awareness.on('change', this._awarenessChange)
			}
		}
		this._awarenessChange = ({ added, removed, updated }) => {
			const awarenessStates = /** @type {Awareness} */ (this.awareness).getStates()
			added.forEach(id => {
				//updateCursor(twCursors, awarenessStates.get(id), id, wikiDoc, wikiTiddlers)
			})
			updated.forEach(id => {
				//updateCursor(twCursors, awarenessStates.get(id), id, wikiDoc, wikiTiddlers)
			})
			removed.forEach(id => {
				//twCursors.removeCursor(id.toString())
			})
		}
		this._storeTiddler = (yMap) => {
			let fields = yMap.toJSON();
			if($tw.node) {
				syncer.wiki.addTiddler(new $tw.Tiddler(fields));
			} else {
				syncer.storeTiddler(fields);
			}
		}
		this._tiddlersObserver = (events,transaction) => {
			mux(() => {
				if(transaction.origin !== this) {
					let targets = new Set();
					events.forEach(event => {
						if(!event.target.parent) {
							// Top level event, one or more tiddlers added
							event.changes.added && event.changes.added.forEach(item => {
								targets.add(item.content.type);
							});
						} else {
							// YMap or YText event, a tiddler was updated
							targets.add(this.wikiTiddlers.get(event.path[0]));
						}
					});
					targets.forEach((target) => {
						this.logger.log(`Stored ${target.get('title')}`);
						this._storeTiddler(target);
					});
				}
			})
		}
		this._tombstonesObserver = (event,transaction) => {
			mux(() => {
				if(transaction.origin !== this) {
					event.changes.added && event.changes.added.forEach(item => {
						$tw.utils.each(item.content.arr,(title) => {
							// A tiddler was deleted
							this.logger.log(`Deleted ${title}`);
							syncer.wiki.deleteTiddler(title);
						});						
					});
				}
			})
		}
		this.wikiTiddlers.observeDeep(this._tiddlersObserver)
		this.wikiTombstones.observe(this._tombstonesObserver)
		this._updateSelection = () => {
			// always check selection
			if (this.awareness && twCursors) {
				const sel = syncer.wiki.getSelection()
				const aw = /** @type {any} */ (this.awareness.getLocalState())
				if (sel === null) {
					if (this.awareness.getLocalState() !== null) {
						this.awareness.setLocalStateField('cursor', /** @type {any} */ (null))
					}
				} else {
					const anchor = Y.createRelativePositionFromTypeIndex(wikiTiddlers, sel.index)
					const head = Y.createRelativePositionFromTypeIndex(wikiTiddlers, sel.index + sel.length)
					if (!aw || !aw.cursor || !Y.compareRelativePositions(anchor, aw.cursor.anchor) || !Y.compareRelativePositions(head, aw.cursor.head)) {
						this.awareness.setLocalStateField('cursor', {
							anchor,
							head
						})
					}
				}
				// update all remote cursor locations
				this.awareness.getStates().forEach((aw, clientId) => {
					updateCursor(twCursors, aw, clientId, wikiDoc, wikiTiddlers)
				})
			}
		}
		this._save = (tiddler) => {
			// Only proccess a save if not read-only & hash of both sides of the binding are different
			if(!(tiddler instanceof $tw.Tiddler)) {
				return;
			}
			if (syncer.syncadaptor.isReadOnly) {
				syncer.enqueueLoadTiddler(tiddler.fields.title); 
			} else {
				let tiddlerIndex = this.wikiTitles.toArray().indexOf(tiddler.fields.title);
				let tiddlerMap = this.wikiTiddlers.get(tiddlerIndex) || new Y.Map();
				if(tiddlerIndex == -1){
					this.wikiTiddlers.push([tiddlerMap]);
					this.wikiTitles.push([tiddler.fields.title]);
				}
				let tsIndex = this.wikiTombstones.toArray().indexOf(tiddler.fields.title);
				if(tsIndex !== -1) {
					this.wikiTombstones.delete(tsIndex,1)
				}
				tiddlerMap.forEach((value,key) => {
					if(!tiddler.hasField(key)) {
						this.logger.log(`Update, remove '${key}' from '${tiddler.fields.title}'`);
						tiddlerMap.delete(key);
					}
				})
				$tw.utils.each(tiddler.getFieldStrings(),(field,name) => {
					if(	!tiddlerMap.has(name) ||
						$tw.utils.hashString(tiddlerMap.get(name).toString()) != $tw.utils.hashString(field)
					) {
						this.logger.log(`Update, set '${name}' on '${tiddler.fields.title}'`);
						if(name.startsWith("text") || this.textFields.indexOf(name) != -1) {
							let yText = tiddlerMap.get(name) || new Y.Text();
							if (!tiddlerMap.has(name)) {
								tiddlerMap.set(name,yText);
							}
							let oldDelta = new Delta().insert(yText.toString()),
							newDelta = new Delta().insert(field),
							diff = oldDelta.diff(newDelta);
							if(diff.ops.length > 0) {
								yText.applyDelta(diff.ops);
							}
						} else {
							tiddlerMap.set(name,field);
						}
					}
				});
			}
		}
		this._load = (title) => {
			let fields = null;
			let tiddlerIndex = this.wikiTitles.toArray().indexOf(title)
			if(this.wikiTombstones.toArray().indexOf(title) == -1 && tiddlerIndex !== -1) {
				fields = this.wikiTiddlers.get(tiddlerIndex).toJSON();
			}
			return fields;
		}
		this._delete = (title) => {
			if ($tw.browser && syncer.syncadaptor.isReadOnly) {
				syncer.enqueueLoadTiddler(title); 
			} else {
				this.logger.log(`Delete tiddler ${title}`);
				let tiddlerIndex = this.wikiTitles.toArray().indexOf(title)
				if(tiddlerIndex !== -1 ) {
					this.wikiTitles.delete(tiddlerIndex,1)
					this.wikiTiddlers.delete(tiddlerIndex,1)
				}
				if(this.wikiTombstones.toArray().indexOf(title) == -1) {
					this.wikiTombstones.push([title])
				}
			}
		}
		// Client awareness
		if(awareness) {
			this._setAwareness(awareness)
		}
	};

	setAwareness (awareness) {
		this.awareness && this.awareness.destroy()
		this._setAwareness(awareness)
		return this
	}
	getUpdates() {
		let updates = {
			modifications: [],
			deletions: []
		}
		let titles = this.syncer.filterFn.call(this.syncer.wiki),
			maps = this.wikiTitles.toArray(),
			diff = titles.filter(x => maps.indexOf(x) === -1)
		// Delete those that are in titles, but not in maps
		diff.forEach((title) => {
			updates.deletions.push(title)
		})
		// Compare and update the tiddlers from the maps
		$tw.utils.each(maps,(title) => {
			let tiddler = this.syncer.wiki.getTiddler(title),
				yTiddler = new $tw.Tiddler(this._load(title))
			if(!tiddler.isEqual(yTiddler)) {
				updates.modifications.push(title);
			}
		})
		return updates
	}
	setUpdates() {
		// Compare all tiddlers in the wiki to their YDoc maps on node server startup
		this.wikiDoc.transact(() => {
			let titles = this.syncer.filterFn.call(this.syncer.wiki),
				maps = this.wikiTitles.toArray(),
				diff = maps.filter(x => titles.indexOf(x) === -1)
			// Delete those that are in maps, but not in titles
			this.logger.log(`Startup, deleting ${diff.length} tiddlers`)
			diff.forEach((title) => {
				this._delete(title)
			});
			// Update the tiddlers that changed during server restart
			this.logger.log(`Startup, testing ${titles.length} tiddlers`)
			$tw.utils.each(titles,(title) => {
				this._save(this.syncer.wiki.getTiddler(title))
			})
		},this)
	}
	save (tiddler,callback,options) {
		try{
			this.wikiDoc.transact(() => {
				this._save(tiddler)
			},this);
			this._updateSelection()
		} catch (error) {
			return callback(error)
		}
		if(!!$tw.y.fsadaptor) {
			return $tw.y.fsadaptor.saveTiddler(tiddler,callback,options)
		} else {
			return callback(null)
		}
	}
	load (title,callback) {
		this.logger.log(`Loading ${title}`)
		let fields = null
		try{
			fields = this._load(title)
		} catch (error) {
			return callback(error)
		}
		return callback(null,fields)
	}
	delete (title,callback,options) {
		try{
			this.wikiDoc.transact(() => {
				this._delete(title)
			},this);
		} catch (error) {
			return callback(error)
		}
		if(!!$tw.y.fsadaptor) {
			return $tw.y.fsadaptor.deleteTiddler(title,callback,options)
		} else {
			return callback(null)
		}
	}
	destroy () {
		this.wikiTiddlers.unobserve(this._tiddlersObserver)
		if(this.awareness) {
			this.awareness.off('change', this._awarenessChange)
		}
	}
 }

exports.TiddlywikiBinding = TiddlywikiBinding;