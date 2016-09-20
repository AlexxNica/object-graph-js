/**
 * @license
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var _ = require('lodash');

var uid = require('./id.js')();
var stdlib = require('ya-stdlib-js');
var remap = stdlib.remap;
var facade = require('facade-js');
var NameRewriter = require('./NameRewriter.js');
var TaskQueue = require('./TaskQueue.js');

// Object identity and/or primitive type data storage.
function ObjectGraph(opts) {
  opts = opts || {};
  this.init(opts);
};

ObjectGraph.prototype.init = function(opts) {
  this.q = new TaskQueue(opts);
  this.busy = false;
  this.blacklistedObjects = opts.blacklistedObjects ||
    this.blacklistedObjects.slice();
  this.nameRewriter = opts.nameRewriter || new NameRewriter();
  this.keysCache = opts.keysCache || {};

  // Try to prevent recursion into internal structures.
  this.blacklistedObjects.push(this);
};

ObjectGraph.prototype.userAgent = typeof navigator !== 'undefined' ?
  navigator.userAgent :
  typeof process !== 'undefined' ? 'NodeJS/' + process.version : 'Unknown';
// Map of primitive types (leaves in object graph).
// NOTE: It must be impossible for $UIDs of visited objects to take on these
// values.
ObjectGraph.prototype.FIRST_TYPE = ObjectGraph.FIRST_TYPE = 1;
ObjectGraph.prototype.LAST_TYPE = ObjectGraph.LAST_TYPE = 7;
ObjectGraph.prototype.types = ObjectGraph.types = {
  'undefined': 1,
  'boolean': 2,
  'number': 3,
  'string': 4,
  'symbol': 5,
  'null': 6,
  'exception': 7,
};

// Never visit/store these object keys.
ObjectGraph.prototype.blacklistedKeys = [ uid.key, uid.key__, '__proto__' ];
// Never visit/store these objects. Defaults to some known namespace polluters
// that we rely on.
// TODO: File bugs against offenders!
ObjectGraph.prototype.blacklistedObjects = [
  '_', // lodash.
  '__core-js_shared__', // Part of core-js in babel-runtime.
].map(function(key) {
  return this[key];
}.bind(typeof window === 'undefined' ? global : window)).filter(
  value => value !== undefined
);

ObjectGraph.prototype.initLazyData = function() {
  stdlib.memo(this, 'invTypes', () => {
    let invTypes = remap['a:b=>b:[a]'](this.types);
    _.forOwn(invTypes, (v, k, o) => o[k] = v[0]);
    return invTypes;
  });
  stdlib.memo(this, 'invData',
              remap['a:b:c=>c:b:[a]'].bind(this, this.data));
  stdlib.memo(this, 'namedData',
              remap['a:b:c=>b:[(a,c)]'].bind(this, this.data));
  stdlib.memo(this, 'invProtos',
              remap['a:b=>b:[a]'].bind(this, this.protos));
  stdlib.memo(this, 'environment', function() {
    return this.nameRewriter.userAgentAsPlatformInfo(this.userAgent);
  }.bind(this));
  stdlib.memo(this, 'allIds_', this.getAllIds_.bind(this));
  stdlib.memo(this, 'allKeys_', this.getAllKeys_.bind(this));
  stdlib.memo(this, 'allKeysMap_', this.getAllKeysMap_.bind(this));

  this.keysCache = {};
};

ObjectGraph.prototype.storeObject = function(id) {
  console.assert( ! this.data[id] , 'Repeated store-id');
  console.assert(typeof id === 'number', 'Illegal object id');
  this.data[id] = {};
  return this.data[id];
};

ObjectGraph.prototype.storeMetadata = function(id) {
  console.assert( ! this.metadata[id] , 'Repeated store-metadata-id');
  this.metadata[id] = {};
  return this.metadata[id];
};

ObjectGraph.prototype.storeProto = function(oId, protoId) {
  console.assert( ! this.protos[oId] , 'Repeated store-proto');
  this.protos[oId] = protoId;
};

// Return an id associated with o if and only if object[key] traversal of o
// should be skipped. Otherwise, return null.
//
// Example of when object[key] traversal should be skipped include when o is
// of primitive type (or value; e.g., null), or when o has already been
// visited.
ObjectGraph.prototype.maybeSkip = function(o) {
  if ( o === null ) return this.types['null'];
  var typeOf = typeof o;
  if ( this.types[typeOf] ) return this.types[typeOf];
  if ( this.data[uid.getId(o)] ) return uid.getId(o);

  return null;
};

// Return true if and only if o[key] is a blacklisted object.
ObjectGraph.prototype.isPropertyBlacklisted = function(o, key) {
  var value;
  try {
    value = o[key];
  } catch(e) {
    return false;
  }
  for ( var i = 0; i < this.blacklistedObjects.length; i++ ) {
    if ( value === this.blacklistedObjects[i] ) return true;
  }
  return false;
};

// Return true if and only if name is a blacklisted key.
ObjectGraph.prototype.isKeyBlacklisted = function(name) {
  for ( var i = 0; i < this.blacklistedKeys.length; i++ ) {
    if ( name === this.blacklistedKeys[i] ) return true;
  }
  return false;
};

// Return a string (possibly identical to name) that is safe to store as a
// Javascript object key without changing the internal behaviour of the
// object.
ObjectGraph.prototype.rewriteName = function(name) {
  return this.nameRewriter.rewriteName(name);
};

// Visit the prototype of o, given its dataMap.
ObjectGraph.prototype.visitPrototype = function(o, dataMap) {
  this.storeProto(uid.getId(o), this.visitObject(o.__proto__));
};

// Visit the property of o named propertyName, given o's dataMap.
ObjectGraph.prototype.visitProperty = function(o, propertyName, dataMap) {
  var name = this.rewriteName(propertyName);
  try {
    dataMap[name] = this.visitObject(o[propertyName]);
  } catch (e) {
    // console.warn('Error accessing', o.$UID, '.', propertyName);
    dataMap[name] = this.types.exception;
  }
};

ObjectGraph.prototype.visitPropertyDescriptors = function(o, metadataMap) {
  var names = Object.getOwnPropertyNames(o);

  // Visit all of o's property descriptors (skipping blacklisted
  // properties).
  for ( var i = 0; i < names.length; i++ ) {
    if ( this.isKeyBlacklisted(names[i]) ||
        this.isPropertyBlacklisted(o, names[i]) ) continue;

    var name = names[i];
    var descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(o, name);
    } catch (e) {}
    if ( descriptor ) {
      metadataMap[name] = stdlib.mapMap(
          descriptor,
          function(descriptorPart) { return descriptorPart ? 1 : 0; }
          );
    } else {
      console.warn('Missing descriptor for name "' + name +
                   '" on object ' + uid.getId(o));
    }
  }
};

// Visit an object, o. Return an id for the object, which may contain type
// information (e.g., number, boolean, null), or indicate the unique identity
// of the object itself.
ObjectGraph.prototype.visitObject = function(o) {
  // Don't process object unless we have to.
  var skip = this.maybeSkip(o);
  if ( skip !== null ) return skip;

  var id = uid.getId(o);

  // Store function-type info in a special place. We visit them like any
  // other object with identity, so their id will not indicate their type.
  if ( typeof o === 'function' ) this.functions.push(id);

  var dataMap = this.storeObject(id);
  var metadataMap = this.storeMetadata(id);

  // Enqueue work: Visit o's prototype and property descriptors.
  this.q.enqueue(this.visitPrototype.bind(this, o, dataMap));
  this.q.enqueue(this.visitPropertyDescriptors.bind(this, o,
                                                    metadataMap));

  // Visit all of o's properties (skipping blacklisted ones).
  var names = Object.getOwnPropertyNames(o);
  for ( var i = 0; i < names.length; i++ ) {
    if ( this.isKeyBlacklisted(names[i]) ||
        this.isPropertyBlacklisted(o, names[i]) ) continue;
    // Enqueue work: Visit o's property.
    this.q.enqueue(this.visitProperty.bind(this, o, names[i], dataMap));
  }

  return id;
};

// Interface method: Clone an ObjectGraph.
ObjectGraph.prototype.clone = function() {
  return this.cloneWithout([]);
};

// Interface method: Clone an ObjectGraph with some IDs removed.
ObjectGraph.prototype.cloneWithout = function(withoutIds) {
  var clone = new ObjectGraph(this);

  clone.key = this.key;
  clone.root = this.root;
  clone.data = _.cloneDeep(this.data);
  clone.metadata = _.cloneDeep(this.metadata);
  clone.protos = _.cloneDeep(this.protos);
  clone.functions = Array.from(this.functions);

  clone.initLazyData();

  return clone.removeIds(withoutIds);
};

// Interface method: Visit the object graph rooted at o.
// Supported options:
//   onDone: Callback when visiting is finished.
//           arguments = [this]
//   key: Initial string key that refers to root object.
ObjectGraph.prototype.capture = function(o, opts) {
  opts = opts || {};
  var prevOnDone = this.q.onDone;
  if ( this.busy ) {
    this.q.onDone = function() {
      prevOnDone.apply(this, arguments);
      this.capture(o, opts);
    }.bind(this);
    return this;
  }
  this.busy = true;

  this.timestamp = null;
  this.key = opts.key || '';
  this.root = typeof o === 'object' && o !== null ? o.$UID : o;
  this.data = {};
  this.metadata = {};
  this.protos = {};
  this.functions = [];
  this.keysCache = {};

  this.q.onDone = function() {
    this.timestamp = (new Date()).getTime();
    this.initLazyData();
    prevOnDone(this);
    opts.onDone && opts.onDone(this);
    this.busy = false;
  }.bind(this);

  // Edge case: Passed-in object is blacklisted. This is not caught by
  // .isPropertyBlacklisted().
  for ( var i = 0; i < this.blacklistedObjects.length; i++ ) {
    if ( o === this.blacklistedObjects[i] ) {
      this.q.flush();
      return this;
    }
  }

  this.visitObject(o);
  this.q.flush();

  return this;
};

ObjectGraph.prototype.removeRefs_ = function(id, ids) {
  let found = false;
  if (this.invData[id]) {
    _.forOwn(
      this.invData[id],
      (refIds, refKey) => refIds.forEach(
        refId => {
          found = true;
          delete this.data[refId][refKey];
        }
      )
    );
  }
  if (this.invProtos[id]) {
    var newProto = id;
    while (!this.isType(newProto) &&
           ids.some(protoId => protoId === newProto))
      newProto = this.getPrototype(newProto);

    _.forOwn(this.invProtos[id],
             protoId => {
               found = true;
               console.assert(this.protos[protoId] === id);
               this.protos[protoId] = newProto;
             });
  }
  return found;
};

ObjectGraph.prototype.removeData_ = function(id) {
  delete this.data[id];
  delete this.protos[id];
  // TODO: Out-of-date data appears to be causing the need for this check.
  if (this.metadata !== undefined && this.metadata[id] !== undefined)
    delete this.metadata[id];
  return true;
};

// Interface method: Remove ids from the object graph.
// Also clean up objects orphaned by id removals.
ObjectGraph.prototype.removeIds = function(ids) {
  // Do not touch root object or references to it.
  ids = ids.filter(id => id !== this.root);

  // Keep removing objects until no remaining objects are orphaned from root.
  do {
    for (let id of ids) {
      this.removeRefs_(id, ids);
    }
    for (let id of ids) {
      this.removeData_(id);
    }
    this.functions = _.difference(this.functions, ids);

    // Object graph has changed! Flush lazily computed data.
    this.initLazyData();

    ids = this.getAllIds().filter(id => {
      return this.getShortestKey(id) === null;
    });
  } while (ids.length > 0);


  return this;
};

// Interface method: Remove id => key mappings.
ObjectGraph.prototype.removePrimitives = function(idKeyPairs) {
  for (let {id, key} of idKeyPairs) {
    console.assert(this.data[id] && this.isType(this.data[id][key]),
                   `Attempt to remove non-primitive, ${id} . ${key}, with removePrimitives()`);
    delete this.data[id][key];
  }

  this.initLazyData();

  return this;
};

// Interface method: Does this id refer to a type?
ObjectGraph.prototype.isType = function(id) {
  return id >= ( this.FIRST_TYPE || ObjectGraph.FIRST_TYPE ) &&
      id <= ( this.LAST_TYPE || ObjectGraph.LAST_TYPE );
};

// Interface method: Get type associated with id.
ObjectGraph.prototype.getType = function(id) {
  if (this.isType(id)) return this.invTypes[id];
  return 'object';
};

// Interface method: Does id refer to a function?
ObjectGraph.prototype.isFunction = function(id) {
  if ( ! id ) return false;

  // TODO: Should we store a lazy map of these to make this faster?
  for ( var i = 0; i < this.functions.length; i++ ) {
    if ( id === this.functions[i] ) return true;
  }

  return false;
};

// Interface method: Get ids of all objects that are functions.
ObjectGraph.prototype.getFunctions = function() {
  return this.functions.slice();
};

// Interface method: Get all ids in the system.
ObjectGraph.prototype.getAllIds = function() {
  return this.allIds_;
};

ObjectGraph.prototype.getAllIds_ = function() {
  var ids = [];
  var strIds = Object.getOwnPropertyNames(this.data);
  for ( var i = 0; i < strIds.length; i++ ) {
    if ( this.isKeyBlacklisted(strIds[i]) ) continue;
    var id = parseInt(strIds[i]);
    console.assert(!isNaN(id), 'Non-numeric id');
    ids.push(id);
  }
  return ids.sort();
};



// Interface method: Get object's key names, optionally filtered by
// opt_predicate.
ObjectGraph.prototype.getObjectKeys = function(id, opt_predicate) {
  if ( ! this.data[id] ) return [];
  var data = this.data[id];
  var keys = Object.getOwnPropertyNames(data);
  if ( ! opt_predicate ) return keys.sort();
  return keys.filter(function(key) {
    return opt_predicate(data[key], key);
  }).sort();
};

// Interface method: Get all keys that refer to an object id.
ObjectGraph.prototype.getKeys = function(id) {
  // Doing one BFS for all key names is much more efficient than repeating it
  // lazily. Trigger complete cache fill with getAllKeys().
  let keys = this.getAllKeys()[id];
  return keys ? keys.slice() : [];
};

// Interface method: Get shortest key that refers to an object id.
ObjectGraph.prototype.getShortestKey = function(id) {
  return this.getKeys(id)[0] || null;
};

// Interface method: Get all keys for all ids; returns a map of the form:
// { id: [keys] }.
ObjectGraph.prototype.getAllKeys = function() {
  return this.allKeys_;
};

// Compute complete set of lookup keys for objects.
// TODO: Doing this in reverse, exploiting cached prefixes would allow us to
// be more incremental about this.
ObjectGraph.prototype.getAllKeys_ = function() {
  let q = [{id: this.root, key: this.key}];
  let seen = {};
  let strs = {};

  for (let i = 0; i < q.length; i++) {
    let item = q[i];
    this.keysCache[item.id] = strs[item.id] = strs[item.id] || [];
    strs[item.id].push(item.key);
    if (seen[item.id]) continue;
    seen[item.id] = true;
    if (this.isType(item.id)) continue;
    let keys = Object.getOwnPropertyNames(this.data[item.id]);
    q.push.apply(
      q,
      keys.map(key => {
        return {id: this.data[item.id][key], key: item.key + '.' + key};
      }).concat([{
        id: this.getPrototype(item.id),
        key: item.key + '.__proto__',
      }]).sort((a, b) => a.key.length - b.key.length)
    );
  }

  return strs;
};

// Interface method: Get all keys for all ids; returns a map of the form:
// { id: [keys] }.
ObjectGraph.prototype.getAllKeysMap = function() {
  return this.allKeysMap_;
};

ObjectGraph.prototype.getAllKeysMap_ = function() {
  var allKeys = this.getAllKeys();
  var map = {};
  var ids = Object.getOwnPropertyNames(allKeys);
  for ( var i = 0; i < ids.length; i++ ) {
    var keys = allKeys[ids[i]];
    for ( var j = 0; j < keys.length; j++ ) {
      map[keys[j]] = 1;
    }
  }
  return map;
};

// Interface method: Get prototype for id.
ObjectGraph.prototype.getPrototype = function(id) {
  return this.protos[id] || this.types['null'];
};

// Helper to .lookup() interface method; operates over path array starting
// from root.
ObjectGraph.prototype.lookup_ = function(path, root) {
  var id = root, nextId;
  for ( var i = 0; i < path.length; i++ ) {
    var name = path[i];
    if ( name === '__proto__' ) {
      nextId = this.getPrototype(id);
    } else {
      while ( ! this.isType(id) && ! ( nextId = this.data[id][name] ) )
        id = this.getPrototype(id);
    }
    if ( this.isType(id) ) return null;
    if ( typeof nextId !== 'number' ) debugger;
    id = nextId;
  }
  return id || null;
};

// Interface method: Perform property lookup over a dot-separated key.
// E.g., .lookup("foo.bar.baz") will start with the root object, then
// perform property lookup for "foo", then "bar", then "baz", falling back on
// prototypes as necessary.
ObjectGraph.prototype.lookup = function(key, opt_root) {
  var root = opt_root || this.root;
  return this.lookup_(key.split('.'), root);
};

// What to store when invoking toJSON.
ObjectGraph.jsonKeys = [ 'timestamp', 'userAgent', 'root', 'key', 'data',
                         'protos', 'types', 'keys', 'blacklistedKeys',
                         'functions', 'metadata' ].sort();

// Store minimal data for serialization.
ObjectGraph.prototype.toJSON = function() {
  var o = {};
  var keys = ObjectGraph.jsonKeys;
  for ( var i = 0; i < ObjectGraph.jsonKeys.length; i++ ) {
    o[keys[i]] = this[keys[i]];
  }
  return o;
};

// Load minimal data from serialization.
ObjectGraph.fromJSON = function(o) {
  var ov = new ObjectGraph();
  var keys =  ObjectGraph.jsonKeys;
  for ( var i = 0; i < ObjectGraph.jsonKeys.length; i++ ) {
    ov[keys[i]] = o[keys[i]];
  }
  ov.initLazyData();
  return ov;
};

module.exports = facade(ObjectGraph, {
  properties: [ 'userAgent' ],
  methods: {
    clone: 1, cloneWithout: 1, capture: 1, removeIds: 1, removePrimitives: 1,
    isType: 1, getType: 1, isFunction: 1, getFunctions: 1, getAllIds: 1,
    getObjectKeys: 1, getKeys: 1, getShortestKey: 1, getAllKeys: 1,
    getAllKeysMap: 1, toJSON: 1, getPrototype: 1, lookup: 1,
    blacklistObject: function(o) {
      this.blacklistedObjects.push(o);
    },
  },
  classFns: {
    fromJSON: 'factory',
    blacklistObject: function(o) {
      this.prototype.blacklistedObjects.push(o);
    },
  },
});
