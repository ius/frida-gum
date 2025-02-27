/* jshint esnext: true, evil: true */
(function () {
    "use strict";

    const engine = global;
    let _runtime = null;
    let _api = null;
    let cachedObjCApi = {};

    Object.defineProperty(engine, 'ObjC', {
        enumerable: true,
        get: function () {
            if (_runtime === null) {
                _runtime = new Runtime();
            }
            return _runtime;
        }
    });

    function Runtime() {
        const pointerSize = Process.pointerSize;
        const api = getApi();
        const realizedClasses = new Set([]);
        const classRegistry = new ClassRegistry();
        const protocolRegistry = new ProtocolRegistry();
        const scheduledCallbacks = [];
        const bindings = {};
        const msgSendBySignatureId = {};
        const msgSendSuperBySignatureId = {};
        let cachedNSString = null;
        let cachedNSStringCtor = null;
        const PRIV = Symbol('priv');

        Object.defineProperty(this, 'available', {
            enumerable: true,
            get: function () {
                return api !== null;
            }
        });

        Object.defineProperty(this, 'api', {
            enumerable: true,
            value: cachedObjCApi
        });

        Object.defineProperty(this, 'classes', {
            enumerable: true,
            value: classRegistry
        });

        Object.defineProperty(this, 'protocols', {
            enumerable: true,
            value: protocolRegistry
        });

        Object.defineProperty(this, 'Object', {
            enumerable: true,
            value: ObjCObject
        });

        Object.defineProperty(this, 'Protocol', {
            enumerable: true,
            value: ObjCProtocol
        });

        Object.defineProperty(this, 'Block', {
            enumerable: true,
            value: Block
        });

        Object.defineProperty(this, 'mainQueue', {
            enumerable: true,
            get: function () {
                return api._dispatch_main_q;
            }
        });

        Object.defineProperty(this, 'registerProxy', {
            enumerable: true,
            value: registerProxy
        });

        Object.defineProperty(this, 'registerClass', {
            enumerable: true,
            value: registerClass
        });

        Object.defineProperty(this, 'bind', {
            enumerable: true,
            value: bind
        });

        Object.defineProperty(this, 'unbind', {
            enumerable: true,
            value: unbind
        });

        Object.defineProperty(this, 'getBoundData', {
            enumerable: true,
            value: getBoundData
        });

        Object.defineProperty(this, 'choose', {
            enumerable: true,
            value: choose
        });

        Object.defineProperty(this, 'chooseSync', {
            enumerable: true,
            value: function (specifier) {
                const instances = [];
                choose(specifier, {
                    onMatch: function (i) {
                        instances.push(i);
                    },
                    onComplete: function () {
                    }
                });
                return instances;
            }
        });

        this.schedule = function (queue, work) {
            const NSAutoreleasePool = this.classes.NSAutoreleasePool;
            const workCallback = new NativeCallback(function () {
                const pool = NSAutoreleasePool.alloc().init();
                let pendingException = null;
                try {
                    work();
                } catch (e) {
                    pendingException = e;
                }
                pool.release();
                setTimeout(function () {
                    scheduledCallbacks.splice(scheduledCallbacks.indexOf(workCallback), 1);
                }, 0);
                if (pendingException !== null) {
                    throw pendingException;
                }
            }, 'void', ['pointer']);
            scheduledCallbacks.push(workCallback);
            api.dispatch_async_f(queue, NULL, workCallback);
        };

        this.implement = function (method, fn) {
            return new NativeCallback(fn, method.returnType, method.argumentTypes);
        };

        this.selector = selector;

        this.selectorAsString = selectorAsString;

        function selector(name) {
            return api.sel_registerName(Memory.allocUtf8String(name));
        }

        function selectorAsString(sel) {
            return Memory.readUtf8String(api.sel_getName(sel));
        }

        const registryBuiltins = new Set([
            "hasOwnProperty",
            "toJSON",
            "toString",
            "valueOf"
        ]);

        function ClassRegistry() {
            const cachedClasses = {};
            let numCachedClasses = 0;

            const registry = new Proxy(this, {
                has(targetOrName, name) {
                    /* workaround for v8 passing only a single argument */
                    const propName = (name !== undefined) ? name : targetOrName;
                    return hasClass(propName);
                },
                get(target, name) {
                    switch (name) {
                        case "hasOwnProperty":
                            return hasClass;
                        case "toJSON":
                            return toJSON;
                        case "toString":
                            return toString;
                        case "valueOf":
                            return valueOf;
                        default:
                            const klass = findClass(name);
                            return (klass !== null) ? klass : undefined;
                    }
                },
                set(target, name, value) {
                    throw new Error("Invalid operation");
                },
                enumerate() {
                    return this.keys();
                },
                iterate() {
                    const props = this.keys();
                    let i = 0;
                    return {
                        next() {
                            if (i === props.length)
                                throw StopIteration;
                            return props[i++];
                        }
                    };
                },
                keys() {
                    let numClasses = api.objc_getClassList(NULL, 0);
                    if (numClasses !== numCachedClasses) {
                        // It's impossible to unregister classes in ObjC, so if the number of
                        // classes hasn't changed, we can assume that the list is up to date.
                        const classHandles = Memory.alloc(numClasses * pointerSize);
                        numClasses = api.objc_getClassList(classHandles, numClasses);
                        for (let i = 0; i !== numClasses; i++) {
                            const handle = Memory.readPointer(classHandles.add(i * pointerSize));
                            const name = Memory.readUtf8String(api.class_getName(handle));
                            cachedClasses[name] = handle;
                        }
                    }
                    return Object.keys(cachedClasses);
                },
                ownKeys() {
                     return this.keys();
                },
                getOwnPropertyNames() {
                    return this.keys();
                }
            });

            function hasClass(name) {
                if (registryBuiltins.has(name))
                    return true;
                return findClass(name) !== null;
            }

            function getClass(name) {
                const cls = findClass(name);
                if (cls === null)
                    throw new Error("Unable to find class '" + name + "'");
                return cls;
            }

            function findClass(name) {
                let handle = cachedClasses[name];
                if (handle === undefined)
                    handle = api.objc_lookUpClass(Memory.allocUtf8String(name));
                if (handle.isNull())
                    return null;
                return new ObjCObject(handle, undefined, true);
            }

            function toJSON() {
                return Object.keys(registry).reduce(function (r, name) {
                    r[name] = getClass(name).toJSON();
                    return r;
                }, {});
            }

            function toString() {
                return "ClassRegistry";
            }

            function valueOf() {
                return "ClassRegistry";
            }

            return registry;
        }

        function ProtocolRegistry() {
            let cachedProtocols = {};

            const registry = new Proxy(this, {
                has(targetOrName, name) {
                    /* workaround for v8 passing only a single argument */
                    const propName = (name !== undefined) ? name : targetOrName;
                    return hasProtocol(propName);
                },
                get(target, name) {
                    switch (name) {
                        case "hasOwnProperty":
                            return hasProtocol;
                        case "toJSON":
                            return toJSON;
                        case "toString":
                            return toString;
                        case "valueOf":
                            return valueOf;
                        default:
                            const proto = findProtocol(name);
                            return (proto !== null) ? proto : undefined;
                    }
                },
                set(target, name, value) {
                    throw new Error("Invalid operation");
                },
                enumerate() {
                    return this.keys();
                },
                iterate() {
                    const props = this.keys();
                    let i = 0;
                    return {
                        next() {
                            if (i === props.length)
                                throw StopIteration;
                            return props[i++];
                        }
                    };
                },
                keys() {
                    const protocolNames = [];
                    cachedProtocols = {};
                    const numProtocolsBuf = Memory.alloc(pointerSize);
                    let protocolHandles = api.objc_copyProtocolList(numProtocolsBuf);
                    try {
                        const numProtocols = Memory.readUInt(numProtocolsBuf);
                        for (let i = 0; i !== numProtocols; i++) {
                            const handle = Memory.readPointer(protocolHandles.add(i * pointerSize));
                            const name = Memory.readUtf8String(api.protocol_getName(handle));
                            protocolNames.push(name);
                            cachedProtocols[name] = handle;
                        }
                    } finally {
                        api.free(protocolHandles);
                    }
                    return protocolNames;
                },
                ownKeys() {
                     return this.keys();
                }
            });

            function hasProtocol(name) {
                if (registryBuiltins.has(name))
                    return true;
                return findProtocol(name) !== null;
            }

            function findProtocol(name) {
                let handle = cachedProtocols[name];
                if (handle === undefined)
                    handle = api.objc_getProtocol(Memory.allocUtf8String(name));
                if (handle.isNull())
                    return null;
                return new ObjCProtocol(handle);
            }

            function toJSON() {
                return Object.keys(registry).reduce(function (r, name) {
                    r[name] = { handle: cachedProtocols[name] };
                    return r;
                }, {});
            }

            function toString() {
                return "ProtocolRegistry";
            }

            function valueOf() {
                return "ProtocolRegistry";
            }

            return registry;
        }

        const objCObjectBuiltins = new Set([
            "prototype",
            "handle",
            "hasOwnProperty",
            "toJSON",
            "toString",
            "valueOf",
            "equals",
            "$kind",
            "$super",
            "$superClass",
            "$class",
            "$className",
            "$protocols",
            "$methods",
            "$ownMethods"
        ]);

        function ObjCObject(handle, protocol, cachedIsClass, superSpecifier) {
            let cachedClassHandle = null;
            let cachedKind = null;
            let cachedSuper = null;
            let cachedSuperClass = null;
            let cachedClass = null;
            let cachedClassName = null;
            let cachedProtocols = null;
            let cachedMethodNames = null;
            let cachedProtocolMethods = null;
            let respondsToSelector = null;
            const cachedMethods = {};
            const replacedMethods = {};
            let cachedNativeMethodNames = null;
            let cachedOwnMethodNames = null;
            let weakRef = null;

            handle = getHandle(handle);

            if (cachedIsClass === undefined) {
                // We need to ensure the class is realized, otherwise calling APIs like object_isClass() will crash.
                // The first message delivery will realize the class, but users intercepting calls to objc_msgSend()
                // and inspecting the first argument will run into this situation.
                const klass = api.object_getClass(handle);
                const key = klass.toString();
                if (!realizedClasses.has(key)) {
                    api.objc_lookUpClass(api.class_getName(klass));
                    realizedClasses.add(key);
                }
            }

            const self = new Proxy(this, {
                has(targetOrName, name) {
                    /* workaround for v8 passing only a single argument */
                    const propName = (name !== undefined) ? name : targetOrName;
                    return hasMethod(propName);
                },
                get(target, name) {
                    switch (name) {
                        case "handle":
                            return handle;
                        case "hasOwnProperty":
                            return hasMethod;
                        case "toJSON":
                            return toJSON;
                        case "toString":
                        case "valueOf":
                            const description = target.description();
                            return description.UTF8String.bind(description);
                        case "equals":
                            return equals;
                        case "$kind":
                            if (cachedKind === null) {
                                if (isClass())
                                    cachedKind = api.class_isMetaClass(handle) ? 'meta-class' : 'class';
                                else
                                    cachedKind = 'instance';
                            }
                            return cachedKind;
                        case "$super":
                            if (cachedSuper === null) {
                                const superHandle = api.class_getSuperclass(classHandle());
                                if (!superHandle.isNull()) {
                                    const specifier = Memory.alloc(2 * pointerSize);
                                    Memory.writePointer(specifier, handle);
                                    Memory.writePointer(specifier.add(pointerSize), superHandle);
                                    cachedSuper = [new ObjCObject(handle, undefined, cachedIsClass, specifier)];
                                } else {
                                    cachedSuper = [null];
                                }
                            }
                            return cachedSuper[0];
                        case "$superClass":
                            if (cachedSuperClass === null) {
                                const superClassHandle = api.class_getSuperclass(classHandle());
                                if (!superClassHandle.isNull()) {
                                    cachedSuperClass = [new ObjCObject(superClassHandle)];
                                } else {
                                    cachedSuperClass = [null];
                                }
                            }
                            return cachedSuperClass[0];
                        case "$class":
                            if (cachedClass === null)
                                cachedClass = new ObjCObject(api.object_getClass(handle), undefined, true);
                            return cachedClass;
                        case "$className":
                            if (cachedClassName === null) {
                                if (superSpecifier)
                                    cachedClassName = Memory.readUtf8String(api.class_getName(Memory.readPointer(superSpecifier.add(pointerSize))));
                                else if (isClass())
                                    cachedClassName = Memory.readUtf8String(api.class_getName(handle));
                                else
                                    cachedClassName = Memory.readUtf8String(api.object_getClassName(handle));
                            }
                            return cachedClassName;
                        case "$protocols":
                            if (cachedProtocols === null) {
                                cachedProtocols = {};
                                const numProtocolsBuf = Memory.alloc(pointerSize);
                                const protocolHandles = api.class_copyProtocolList(handle, numProtocolsBuf);
                                if (!protocolHandles.isNull()) {
                                    try {
                                        const numProtocols = Memory.readUInt(numProtocolsBuf);
                                        for (let i = 0; i !== numProtocols; i++) {
                                            const protocolHandle = Memory.readPointer(protocolHandles.add(i * pointerSize));
                                            const p = new ObjCProtocol(protocolHandle);
                                            cachedProtocols[p.name] = p;
                                        }
                                    } finally {
                                        api.free(protocolHandles);
                                    }
                                }
                            }
                            return cachedProtocols;
                        case "$methods":
                            if (cachedNativeMethodNames === null) {
                                const klass = superSpecifier ? Memory.readPointer(superSpecifier.add(pointerSize)) : classHandle();
                                const meta = api.object_getClass(klass);

                                const names = new Set();

                                let cur = meta;
                                do {
                                    for (let methodName of collectMethodNames(cur, "+ "))
                                        names.add(methodName);
                                    cur = api.class_getSuperclass(cur);
                                } while (!cur.isNull());

                                cur = klass;
                                do {
                                    for (let methodName of collectMethodNames(cur, "- "))
                                        names.add(methodName);
                                    cur = api.class_getSuperclass(cur);
                                } while (!cur.isNull());

                                cachedNativeMethodNames = Array.from(names);
                            }
                            return cachedNativeMethodNames;
                        case "$ownMethods":
                            if (cachedOwnMethodNames === null) {
                                const klass = superSpecifier ? Memory.readPointer(superSpecifier.add(pointerSize)) : classHandle();
                                const meta = api.object_getClass(klass);

                                const classMethods = collectMethodNames(meta, "+ ");
                                const instanceMethods = collectMethodNames(klass, "- ");

                                cachedOwnMethodNames = classMethods.concat(instanceMethods);
                            }
                            return cachedOwnMethodNames;
                        default:
                            if (protocol) {
                                const details = findProtocolMethod(name);
                                if (details === null || !details.implemented)
                                    return undefined;
                            }
                            const wrapper = findMethodWrapper(name);
                            if (wrapper === null)
                                return undefined;
                            return wrapper;
                    }
                },
                set(target, name, value) {
                    throw new Error("Invalid operation");
                },
                enumerate() {
                    return this.keys();
                },
                iterate() {
                    const props = this.keys();
                    let i = 0;
                    return {
                        next() {
                            if (i === props.length)
                                throw StopIteration;
                            return props[i++];
                        }
                    };
                },
                keys() {
                    if (cachedMethodNames === null) {
                        if (!protocol) {
                            const jsNames = {};
                            const nativeNames = {};

                            let cur = api.object_getClass(handle);
                            do {
                                const numMethodsBuf = Memory.alloc(pointerSize);
                                const methodHandles = api.class_copyMethodList(cur, numMethodsBuf);
                                const fullNamePrefix = isClass() ? "+ " : "- ";
                                try {
                                    const numMethods = Memory.readUInt(numMethodsBuf);
                                    for (let i = 0; i !== numMethods; i++) {
                                        const methodHandle = Memory.readPointer(methodHandles.add(i * pointerSize));
                                        const sel = api.method_getName(methodHandle);
                                        const nativeName = Memory.readUtf8String(api.sel_getName(sel));
                                        if (nativeNames[nativeName] !== undefined)
                                            continue;
                                        nativeNames[nativeName] = nativeName;

                                        const jsName = jsMethodName(nativeName);
                                        let serial = 2;
                                        let name = jsName;
                                        while (jsNames[name] !== undefined) {
                                            serial++;
                                            name = jsName + serial;
                                        }
                                        jsNames[name] = name;

                                        const fullName = fullNamePrefix + nativeName;
                                        if (cachedMethods[fullName] === undefined) {
                                            const details = {
                                                sel: sel,
                                                handle: methodHandle,
                                                wrapper: null
                                            };
                                            cachedMethods[fullName] = details;
                                            cachedMethods[name] = details;
                                        }
                                    }
                                } finally {
                                    api.free(methodHandles);
                                }
                                cur = api.class_getSuperclass(cur);
                            } while (!cur.isNull());

                            cachedMethodNames = Object.keys(jsNames);
                        } else {
                            const methodNames = [];

                            const protocolMethods = allProtocolMethods();
                            Object.keys(protocolMethods).forEach(function (methodName) {
                                if (methodName[0] !== '+' && methodName[0] !== '-') {
                                    const details = protocolMethods[methodName];
                                    if (details.implemented)
                                        methodNames.push(methodName);
                                }
                            });

                            cachedMethodNames = methodNames;
                        }
                    }

                    return Array.from(objCObjectBuiltins).concat(cachedMethodNames);
                },
                ownKeys() {
                    return this.keys();
                }
            }, Object.getPrototypeOf(this));

            if (protocol) {
                respondsToSelector = !isClass() ? findMethodWrapper("- respondsToSelector:") : null;
            }

            return self;

            function hasMethod(name) {
                if (objCObjectBuiltins.has(name))
                    return true;
                if (protocol) {
                    const details = findProtocolMethod(name);
                    return !!(details !== null && details.implemented);
                }
                return findMethod(name) !== null;
            }

            function dispose() {
                Object.keys(replacedMethods).forEach(function (key) {
                    const methodHandle = ptr(key);
                    const oldImp = replacedMethods[key];
                    api.method_setImplementation(methodHandle, oldImp);
                });
            }

            function classHandle() {
                if (cachedClassHandle === null)
                    cachedClassHandle = isClass() ? handle : api.object_getClass(handle);
                return cachedClassHandle;
            }

            function isClass() {
                if (cachedIsClass === undefined) {
                    if (api.object_isClass)
                        cachedIsClass = !!api.object_isClass(handle);
                    else
                        cachedIsClass = !!api.class_isMetaClass(api.object_getClass(handle));
                }
                return cachedIsClass;
            }

            function findMethod(rawName) {
                let method = cachedMethods[rawName];
                if (method !== undefined)
                    return method;

                const tokens = parseMethodName(rawName);
                const kind = tokens[0];
                const name = tokens[1];
                const sel = selector(name);
                const fullName = tokens[2];
                const defaultKind = isClass() ? '+' : '-';

                if (protocol) {
                    const details = findProtocolMethod(fullName);
                    if (details !== null) {
                        method = {
                            sel: sel,
                            types: details.types,
                            wrapper: null
                        };
                    }
                }

                if (method === undefined) {
                    const methodHandle = (kind === '+') ?
                        api.class_getClassMethod(classHandle(), sel) :
                        api.class_getInstanceMethod(classHandle(), sel);
                    if (!methodHandle.isNull()) {
                        method = {
                            sel: sel,
                            handle: methodHandle,
                            wrapper: null
                        };
                    } else {
                        if (!isClass() && kind === '-' && name !== "methodSignatureForSelector:" && "- methodSignatureForSelector:" in self) {
                            const s = self.methodSignatureForSelector_(sel);
                            if (s === null)
                                return null;
                            const numArgs = s.numberOfArguments();
                            const frameSize = numArgs * pointerSize;
                            let types = s.methodReturnType() + frameSize;
                            for (let i = 0; i !== numArgs; i++) {
                                const frameOffset = (i * pointerSize);
                                types += s.getArgumentTypeAtIndex_(i) + frameOffset;
                            }
                            method = {
                                sel: sel,
                                types: types,
                                wrapper: null
                            };
                        } else {
                            return null;
                        }
                    }
                }

                cachedMethods[fullName] = method;
                if (kind === defaultKind)
                    cachedMethods[jsMethodName(name)] = method;

                return method;
            }

            function findProtocolMethod(rawName) {
                const protocolMethods = allProtocolMethods();
                const details = protocolMethods[rawName];
                return (details !== undefined) ? details : null;
            }

            function allProtocolMethods() {
                if (cachedProtocolMethods === null) {
                    const methods = {};

                    const protocols = collectProtocols(protocol);
                    const defaultKind = isClass() ? '+' : '-';
                    Object.keys(protocols).forEach(function (name) {
                        const p = protocols[name];
                        const m = p.methods;
                        Object.keys(m).forEach(function (fullMethodName) {
                            const method = m[fullMethodName];
                            const methodName = fullMethodName.substr(2);
                            const kind = fullMethodName[0];

                            let didCheckImplemented = false;
                            let implemented = false;
                            const details = {
                                types: method.types
                            };
                            Object.defineProperty(details, 'implemented', {
                                get: function () {
                                    if (!didCheckImplemented) {
                                        if (method.required) {
                                            implemented = true;
                                        } else {
                                            implemented = (respondsToSelector !== null && respondsToSelector.call(self, selector(methodName)));
                                        }
                                        didCheckImplemented = true;
                                    }
                                    return implemented;
                                }
                            });

                            methods[fullMethodName] = details;
                            if (kind === defaultKind)
                                methods[jsMethodName(methodName)] = details;
                        });
                    });

                    cachedProtocolMethods = methods;
                }

                return cachedProtocolMethods;
            }

            function findMethodWrapper(name) {
                const method = findMethod(name);
                if (method === null)
                    return null;
                let wrapper = method.wrapper;
                if (wrapper === null) {
                    wrapper = makeMethodInvocationWrapper(method, self, superSpecifier, replaceMethodImplementation);
                    method.wrapper = wrapper;
                }
                return wrapper;
            }

            function replaceMethodImplementation(methodHandle, imp, oldImp) {
                api.method_setImplementation(methodHandle, imp);

                if (!imp.equals(oldImp))
                    replacedMethods[methodHandle.toString()] = oldImp;
                else
                    delete replacedMethods[methodHandle.toString()];

                if (weakRef === null)
                    weakRef = WeakRef.bind(self, dispose);
            }

            function parseMethodName(rawName) {
                const match = /([+-])\s(\S+)/.exec(rawName);
                let name, kind;
                if (match === null) {
                    kind = isClass() ? '+' : '-';
                    name = objcMethodName(rawName);
                } else {
                    kind = match[1];
                    name = match[2];
                }
                const fullName = kind + name;
                return [kind, name, fullName];
            }

            function toJSON() {
                return {
                    handle: handle.toString()
                };
            }

            function equals(ptr) {
                return handle.equals(getHandle(ptr));
            }
        }

        function collectMethodNames(klass, prefix) {
            const names = [];

            const numMethodsBuf = Memory.alloc(pointerSize);
            const methodHandles = api.class_copyMethodList(klass, numMethodsBuf);
            try {
                const numMethods = Memory.readUInt(numMethodsBuf);
                for (let i = 0; i !== numMethods; i++) {
                    const methodHandle = Memory.readPointer(methodHandles.add(i * pointerSize));
                    const sel = api.method_getName(methodHandle);
                    const nativeName = Memory.readUtf8String(api.sel_getName(sel));
                    names.push(prefix + nativeName);
                }
            } finally {
                api.free(methodHandles);
            }

            return names;
        }

        function ObjCProtocol(handle) {
            let cachedName = null;
            let cachedProtocols = null;
            let cachedProperties = null;
            let cachedMethods = null;

            Object.defineProperty(this, 'handle', {
                value: handle,
                enumerable: true
            });

            Object.defineProperty(this, 'name', {
                get: function () {
                    if (cachedName === null)
                        cachedName = Memory.readUtf8String(api.protocol_getName(handle));
                    return cachedName;
                },
                enumerable: true
            });

            Object.defineProperty(this, 'protocols', {
                get: function () {
                    if (cachedProtocols === null) {
                        cachedProtocols = {};
                        const numProtocolsBuf = Memory.alloc(pointerSize);
                        const protocolHandles = api.protocol_copyProtocolList(handle, numProtocolsBuf);
                        if (!protocolHandles.isNull()) {
                            try {
                                const numProtocols = Memory.readUInt(numProtocolsBuf);
                                for (let i = 0; i !== numProtocols; i++) {
                                    const protocolHandle = Memory.readPointer(protocolHandles.add(i * pointerSize));
                                    const protocol = new ObjCProtocol(protocolHandle);
                                    cachedProtocols[protocol.name] = protocol;
                                }
                            } finally {
                                api.free(protocolHandles);
                            }
                        }
                    }
                    return cachedProtocols;
                },
                enumerable: true
            });

            Object.defineProperty(this, 'properties', {
                get: function () {
                    if (cachedProperties === null) {
                        cachedProperties = {};
                        const numBuf = Memory.alloc(pointerSize);
                        const propertyHandles = api.protocol_copyPropertyList(handle, numBuf);
                        if (!propertyHandles.isNull()) {
                            try {
                                const numProperties = Memory.readUInt(numBuf);
                                for (let i = 0; i !== numProperties; i++) {
                                    const propertyHandle = Memory.readPointer(propertyHandles.add(i * pointerSize));
                                    const propName = Memory.readUtf8String(api.property_getName(propertyHandle));
                                    const attributes = {};
                                    const attributeEntries = api.property_copyAttributeList(propertyHandle, numBuf);
                                    if (!attributeEntries.isNull()) {
                                        try {
                                            const numAttributeValues = Memory.readUInt(numBuf);
                                            for (let j = 0; j !== numAttributeValues; j++) {
                                                const attributeEntry = attributeEntries.add(j * (2 * pointerSize));
                                                const name = Memory.readUtf8String(Memory.readPointer(attributeEntry));
                                                const value = Memory.readUtf8String(Memory.readPointer(attributeEntry.add(pointerSize)));
                                                attributes[name] = value;
                                            }
                                        } finally {
                                            api.free(attributeEntries);
                                        }
                                    }
                                    cachedProperties[propName] = attributes;
                                }
                            } finally {
                                api.free(propertyHandles);
                            }
                        }
                    }
                    return cachedProperties;
                },
                enumerable: true
            });

            Object.defineProperty(this, 'methods', {
                get: function () {
                    if (cachedMethods === null) {
                        cachedMethods = {};
                        const numBuf = Memory.alloc(pointerSize);
                        collectMethods(cachedMethods, numBuf, { required: true, instance: false });
                        collectMethods(cachedMethods, numBuf, { required: false, instance: false });
                        collectMethods(cachedMethods, numBuf, { required: true, instance: true });
                        collectMethods(cachedMethods, numBuf, { required: false, instance: true });
                    }
                    return cachedMethods;
                },
                enumerable: true
            });

            function collectMethods(methods, numBuf, spec) {
                const methodDescValues = api.protocol_copyMethodDescriptionList(handle, spec.required ? 1 : 0, spec.instance ? 1 : 0, numBuf);
                if (methodDescValues.isNull())
                    return;
                try {
                    const numMethodDescValues = Memory.readUInt(numBuf);
                    for (let i = 0; i !== numMethodDescValues; i++) {
                        const methodDesc = methodDescValues.add(i * (2 * pointerSize));
                        const name = (spec.instance ? '- ' : '+ ') + selectorAsString(Memory.readPointer(methodDesc));
                        const types = Memory.readUtf8String(Memory.readPointer(methodDesc.add(pointerSize)));
                        methods[name] = {
                            required: spec.required,
                            types: types
                        };
                    }
                } finally {
                    api.free(methodDescValues);
                }
            }
        }

        let blockDescriptorAllocSize, blockDescriptorDeclaredSize, blockDescriptorOffsets;
        let blockSize, blockOffsets;
        if (pointerSize === 4) {
            blockDescriptorAllocSize = 16; /* sizeof (BlockDescriptor) == 12 */
            blockDescriptorDeclaredSize = 20;
            blockDescriptorOffsets = {
                reserved: 0,
                size: 4,
                rest: 8
            };

            blockSize = 20;
            blockOffsets = {
                isa: 0,
                flags: 4,
                reserved: 8,
                invoke: 12,
                descriptor: 16
            };
        } else {
            blockDescriptorAllocSize = 32; /* sizeof (BlockDescriptor) == 24 */
            blockDescriptorDeclaredSize = 32;
            blockDescriptorOffsets = {
                reserved: 0,
                size: 8,
                rest: 16
            };

            blockSize = 32;
            blockOffsets = {
                isa: 0,
                flags: 8,
                reserved: 12,
                invoke: 16,
                descriptor: 24
            };
        }

        const BLOCK_HAS_COPY_DISPOSE = (1 << 25);
        const BLOCK_HAS_CTOR =         (1 << 26);
        const BLOCK_IS_GLOBAL =        (1 << 28);
        const BLOCK_HAS_STRET =        (1 << 29);
        const BLOCK_HAS_SIGNATURE =    (1 << 30);

        function Block(target) {
            const priv = {};
            this[PRIV] = priv;

            if (target instanceof NativePointer) {
                const descriptor = Memory.readPointer(target.add(blockOffsets.descriptor));

                this.handle = target;

                const flags = Memory.readU32(target.add(blockOffsets.flags));
                if ((flags & BLOCK_HAS_SIGNATURE) !== 0) {
                    const signatureOffset = ((flags & BLOCK_HAS_COPY_DISPOSE) !== 0) ? 2 : 0;
                    priv.types = Memory.readCString(Memory.readPointer(descriptor.add(blockDescriptorOffsets.rest + (signatureOffset * pointerSize))));
                    priv.signature = parseSignature(priv.types);
                }
            } else {
                if (!(typeof target === 'object' &&
                        (target.hasOwnProperty('types') || (target.hasOwnProperty('retType') && target.hasOwnProperty('argTypes'))) &&
                        target.hasOwnProperty('implementation'))) {
                    throw new Error('Expected type metadata and implementation');
                }

                let types = target.types;
                if (types === undefined) {
                    types = unparseSignature(target.retType, ['block'].concat(target.argTypes));
                }

                const descriptor = Memory.alloc(blockDescriptorAllocSize + blockSize);
                const block = descriptor.add(blockDescriptorAllocSize);
                const typesStr = Memory.allocUtf8String(types);

                Memory.writeULong(descriptor.add(blockDescriptorOffsets.reserved), 0);
                Memory.writeULong(descriptor.add(blockDescriptorOffsets.size), blockDescriptorDeclaredSize);
                Memory.writePointer(descriptor.add(blockDescriptorOffsets.rest), typesStr);

                Memory.writePointer(block.add(blockOffsets.isa), classRegistry.__NSGlobalBlock__);
                Memory.writeU32(block.add(blockOffsets.flags), BLOCK_HAS_SIGNATURE | BLOCK_IS_GLOBAL);
                Memory.writeU32(block.add(blockOffsets.reserved), 0);
                Memory.writePointer(block.add(blockOffsets.descriptor), descriptor);

                this.handle = block;

                priv.descriptor = descriptor;
                priv.types = types;
                priv.typesStr = typesStr;
                priv.signature = parseSignature(types);

                this.implementation = target.implementation;
            }
        }

        Object.defineProperty(Block.prototype, 'implementation', {
            enumerable: true,
            get: function () {
                const priv = this[PRIV];
                const address = Memory.readPointer(this.handle.add(blockOffsets.invoke));
                const signature = priv.signature;
                return makeBlockInvocationWrapper(this, signature, new NativeFunction(
                    address,
                    signature.retType.type,
                    signature.argTypes.map(function (arg) { return arg.type; })));
            },
            set: function (func) {
                const priv = this[PRIV];
                const signature = priv.signature;
                priv.callback = new NativeCallback(
                    makeBlockImplementationWrapper(this, signature, func),
                    signature.retType.type,
                    signature.argTypes.map(function (arg) { return arg.type; }));
                Memory.writePointer(this.handle.add(blockOffsets.invoke), priv.callback);
            }
        });

        function collectProtocols(p, acc) {
            acc = acc || {};

            acc[p.name] = p;

            const parentProtocols = p.protocols;
            Object.keys(parentProtocols).forEach(function (name) {
                collectProtocols(parentProtocols[name], acc);
            });

            return acc;
        }

        function registerProxy(properties) {
            const protocols = properties.protocols || [];
            const methods = properties.methods || {};
            const events = properties.events || {};

            const proxyMethods = {
                '- dealloc': function () {
                    this.data.target.release();
                    unbind(this.self);
                    this.super.dealloc();
                },
                '- respondsToSelector:': function (sel) {
                    return this.data.target.respondsToSelector_(sel);
                },
                '- forwardingTargetForSelector:': function (sel) {
                    const callback = this.data.events.forward;
                    if (callback !== undefined)
                        callback.call(this, selectorAsString(sel));
                    return this.data.target;
                },
                '- methodSignatureForSelector:': function (sel) {
                    return this.data.target.methodSignatureForSelector_(sel);
                },
                '- forwardInvocation:': function (invocation) {
                    invocation.invokeWithTarget_(this.data.target);
                }
            };
            for (var key in methods) {
                if (methods.hasOwnProperty(key)) {
                    if (proxyMethods.hasOwnProperty(key))
                        throw new Error("The '" + key + "' method is reserved");
                    proxyMethods[key] = methods[key];
                }
            }

            const ProxyClass = registerClass({
                super: classRegistry.NSProxy,
                protocols: protocols,
                methods: proxyMethods
            });

            return function (target, data) {
                target = (target instanceof NativePointer) ? new ObjCObject(target) : target;
                data = data || {};

                const instance = ProxyClass.alloc().autorelease();

                const boundData = getBoundData(instance);
                boundData.target = target.retain();
                boundData.events = events;
                for (var key in data) {
                    if (data.hasOwnProperty(key)) {
                        if (boundData.hasOwnProperty(key))
                            throw new Error("The '" + key + "' property is reserved");
                        boundData[key] = data[key];
                    }
                }

                this.handle = instance.handle;
            };
        }

        function registerClass(properties) {
            let name = properties.name;
            if (name) {
                if (name in classRegistry)
                    throw new Error("Unable to register already registered class '" + name + "'");
            } else {
                name = makeClassName();
            }
            const superClass = (properties.super !== undefined) ? properties.super : classRegistry.NSObject;
            const protocols = properties.protocols || [];
            const methods = properties.methods || {};
            const methodCallbacks = [];

            const classHandle = api.objc_allocateClassPair(superClass !== null ? superClass.handle : NULL, Memory.allocUtf8String(name), ptr("0"));
            const metaClassHandle = api.object_getClass(classHandle);
            try {
                protocols.forEach(function (protocol) {
                    api.class_addProtocol(classHandle, protocol.handle);
                });

                Object.keys(methods).forEach(function (rawMethodName) {
                    const match = /([+-])\s(\S+)/.exec(rawMethodName);
                    if (match === null)
                        throw new Error("Invalid method name");
                    const kind = match[1];
                    const name = match[2];

                    let method;
                    const value = methods[rawMethodName];
                    if (typeof value === 'function') {
                        let types;
                        if (rawMethodName in superClass) {
                            types = superClass[rawMethodName].types;
                        } else {
                            const protocol = protocols.find(function (protocol) {
                                return rawMethodName in protocol.methods;
                            });
                            types = (protocol !== undefined) ? protocol.methods[rawMethodName].types : null;
                        }
                        if (types === null)
                            throw new Error("Unable to find '" + rawMethodName + "' in super-class or any of its protocols");
                        method = {
                            types: types,
                            implementation: value
                        };
                    } else {
                        method = value;
                    }

                    const target = (kind === '+') ? metaClassHandle : classHandle;
                    let types = method.types;
                    if (types === undefined) {
                        types = unparseSignature(method.retType, [(kind === '+') ? 'class' : 'object', 'selector'].concat(method.argTypes));
                    }
                    const signature = parseSignature(types);
                    const implementation = new NativeCallback(
                        makeMethodImplementationWrapper(signature, method.implementation),
                        signature.retType.type,
                        signature.argTypes.map(function (arg) { return arg.type; }));
                    methodCallbacks.push(implementation);
                    api.class_addMethod(target, selector(name), implementation, Memory.allocUtf8String(types));
                });
            } catch (e) {
                api.objc_disposeClassPair(classHandle);
                throw e;
            }
            api.objc_registerClassPair(classHandle);

            // Keep a reference to the callbacks so they don't get GCed
            classHandle._methodCallbacks = methodCallbacks;

            return new ObjCObject(classHandle);
        }

        function getHandle(obj) {
            if (obj instanceof NativePointer)
                return obj;
            else if (typeof obj === 'object' && obj.hasOwnProperty('handle'))
                return obj.handle;
            else
                throw new Error("Expected NativePointer or ObjC.Object instance");
        }

        function bind(obj, data) {
            const handle = getHandle(obj);
            const self = (obj instanceof ObjCObject) ? obj : new ObjCObject(handle);
            bindings[handle.toString()] = {
                self: self,
                super: self.$super,
                data: data
            };
        }

        function unbind(obj) {
            const handle = getHandle(obj);
            delete bindings[handle.toString()];
        }

        function getBoundData(obj) {
            return getBinding(obj).data;
        }

        function getBinding(obj) {
            const handle = getHandle(obj);
            const key = handle.toString();
            let binding = bindings[key];
            if (binding === undefined) {
                const self = (obj instanceof ObjCObject) ? obj : new ObjCObject(handle);
                binding = {
                    self: self,
                    super: self.$super,
                    data: {}
                };
                bindings[key] = binding;
            }
            return binding;
        }

        function choose(specifier, callbacks) {
            let cls = specifier;
            let subclasses = true;
            if (!(specifier instanceof ObjCObject) && typeof specifier === 'object') {
                cls = specifier.class;
                if (specifier.hasOwnProperty('subclasses'))
                    subclasses = specifier.subclasses;
            }
            if (!(cls instanceof ObjCObject && (cls.$kind === 'class' || cls.$kind === 'meta-class')))
                throw new Error("Expected an ObjC.Object for a class or meta-class");
            const ptr = cls.handle;

            const classHandles = subclasses ? getRecursiveSubclasses(ptr) : [ptr];

            const classes = new Set(classHandles.map(h => h.toString()));

            Process.enumerateMallocRanges({
                onMatch: function (range) {
                    const ptr = range.base;
                    const cls = Memory.readPointer(ptr);
                    if (classes.has(cls.toString()) && range.size >= api.class_getInstanceSize(cls)) {
                        return callbacks.onMatch(new ObjCObject(ptr));
                    }
                },
                onComplete: callbacks.onComplete
            });
        }

        function getRecursiveSubclasses(ptr) {
            const subclasses = [];
            for (let name in classRegistry) {
                const cls = classRegistry[name].handle;
                let c = cls;
                do {
                    if (c.equals(ptr)) {
                        subclasses.push(cls);
                        break;
                    }
                    c = api.class_getSuperclass(c);
                } while (!c.isNull());
            }
            return subclasses;
        }

        function makeMethodInvocationWrapper(method, owner, superSpecifier, replaceImplementation) {
            const sel = method.sel;
            let handle = method.handle;
            let types;
            if (handle === undefined) {
                handle = null;
                types = method.types;
            } else {
                types = Memory.readUtf8String(api.method_getTypeEncoding(handle));
            }

            const signature = parseSignature(types);
            const retType = signature.retType;
            const argTypes = signature.argTypes.slice(2);
            const objc_msgSend = superSpecifier ? getMsgSendSuperImpl(signature) : getMsgSendImpl(signature);

            const argVariableNames = argTypes.map(function (t, i) {
                return "a" + (i + 1);
            });
            const callArgs = [
                superSpecifier ? "superSpecifier" : "this",
                "sel"
            ].concat(argTypes.map(function (t, i) {
                if (t.toNative) {
                    return "argTypes[" + i + "].toNative.call(this, " + argVariableNames[i] + ")";
                }
                return argVariableNames[i];
            }));
            let returnCaptureLeft;
            let returnCaptureRight;
            if (retType.type === 'void') {
                returnCaptureLeft = "";
                returnCaptureRight = "";
            } else if (retType.fromNative) {
                returnCaptureLeft = "return retType.fromNative.call(this, ";
                returnCaptureRight = ")";
            } else {
                returnCaptureLeft = "return ";
                returnCaptureRight = "";
            }
            const m = eval("var m = function (" + argVariableNames.join(", ") + ") { " +
                returnCaptureLeft + "objc_msgSend(" + callArgs.join(", ") + ")" + returnCaptureRight + ";" +
            " }; m;");

            Object.defineProperty(m, 'selector', {
                enumerable: true,
                value: sel
            });

            let oldImp = null;
            Object.defineProperty(m, 'implementation', {
                enumerable: true,
                get: function () {
                    const h = getMethodHandle();

                    return new NativeFunction(api.method_getImplementation(h), m.returnType, m.argumentTypes);
                },
                set: function (imp) {
                    const h = getMethodHandle();

                    if (oldImp === null)
                        oldImp = api.method_getImplementation(h);

                    replaceImplementation(h, imp, oldImp);
                }
            });

            Object.defineProperty(m, 'returnType', {
                enumerable: true,
                value: retType.type
            });

            Object.defineProperty(m, 'argumentTypes', {
                enumerable: true,
                value: signature.argTypes.map(function (t) {
                    return t.type;
                })
            });

            Object.defineProperty(m, 'types', {
                enumerable: true,
                value: types
            });

            function getMethodHandle() {
                if (handle === null) {
                    if (owner.$kind === 'instance') {
                        let cur = owner;
                        do {
                            if ("- forwardingTargetForSelector:" in cur) {
                                const target = cur.forwardingTargetForSelector_(sel);
                                if (target === null)
                                    break;
                                if (target.$kind !== 'instance')
                                    break;
                                const h = api.class_getInstanceMethod(target.$class.handle, sel);
                                if (!h.isNull())
                                    handle = h;
                                else
                                    cur = target;
                            } else {
                                break;
                            }
                        } while (handle === null);
                    }

                    if (handle === null)
                        throw new Error("Unable to find method handle of proxied function");
                }

                return handle;
            }

            return m;
        }

        function makeMethodImplementationWrapper(signature, implementation) {
            const retType = signature.retType;
            const argTypes = signature.argTypes;

            const argVariableNames = argTypes.map(function (t, i) {
                if (i === 0)
                    return "handle";
                else if (i === 1)
                    return "sel";
                else
                    return "a" + (i - 1);
            });
            const callArgs = argTypes.slice(2).map(function (t, i) {
                const argVariableName = argVariableNames[2 + i];
                if (t.fromNative) {
                    return "argTypes[" + (2 + i) + "].fromNative.call(self, " + argVariableName + ")";
                }
                return argVariableName;
            });
            let returnCaptureLeft;
            let returnCaptureRight;
            if (retType.type === 'void') {
                returnCaptureLeft = "";
                returnCaptureRight = "";
            } else if (retType.toNative) {
                returnCaptureLeft = "return retType.toNative.call(self, ";
                returnCaptureRight = ")";
            } else {
                returnCaptureLeft = "return ";
                returnCaptureRight = "";
            }

            const m = eval("var m = function (" + argVariableNames.join(", ") + ") { " +
                "var binding = getBinding(handle);" +
                "var self = binding.self;" +
                returnCaptureLeft + "implementation.call(binding" + (callArgs.length > 0 ? ", " : "") + callArgs.join(", ") + ")" + returnCaptureRight + ";" +
            " }; m;");

            return m;
        }

        function makeBlockInvocationWrapper(block, signature, implementation) {
            const retType = signature.retType;
            const argTypes = signature.argTypes.slice(1);

            const argVariableNames = argTypes.map(function (t, i) {
                return "a" + (i + 1);
            });
            const callArgs = argTypes.map(function (t, i) {
                if (t.toNative) {
                    return "argTypes[" + i + "].toNative.call(this, " + argVariableNames[i] + ")";
                }
                return argVariableNames[i];
            });
            let returnCaptureLeft;
            let returnCaptureRight;
            if (retType.type === 'void') {
                returnCaptureLeft = "";
                returnCaptureRight = "";
            } else if (retType.fromNative) {
                returnCaptureLeft = "return retType.fromNative.call(this, ";
                returnCaptureRight = ")";
            } else {
                returnCaptureLeft = "return ";
                returnCaptureRight = "";
            }
            const f = eval("var f = function (" + argVariableNames.join(", ") + ") { " +
                returnCaptureLeft + "implementation(this" + (callArgs.length > 0 ? ", " : "") + callArgs.join(", ") + ")" + returnCaptureRight + ";" +
            " }; f;");

            return f.bind(block);
        }

        function makeBlockImplementationWrapper(block, signature, implementation) {
            const retType = signature.retType;
            const argTypes = signature.argTypes;

            const argVariableNames = argTypes.map(function (t, i) {
                if (i === 0)
                    return "handle";
                else
                    return "a" + i;
            });
            const callArgs = argTypes.slice(1).map(function (t, i) {
                const argVariableName = argVariableNames[1 + i];
                if (t.fromNative) {
                    return "argTypes[" + (1 + i) + "].fromNative.call(this, " + argVariableName + ")";
                }
                return argVariableName;
            });
            let returnCaptureLeft;
            let returnCaptureRight;
            if (retType.type === 'void') {
                returnCaptureLeft = "";
                returnCaptureRight = "";
            } else if (retType.toNative) {
                returnCaptureLeft = "return retType.toNative.call(this, ";
                returnCaptureRight = ")";
            } else {
                returnCaptureLeft = "return ";
                returnCaptureRight = "";
            }

            const f = eval("var f = function (" + argVariableNames.join(", ") + ") { " +
                "if (!this.handle.equals(handle))" +
                    "this.handle = handle;" +
                returnCaptureLeft + "implementation.call(block" + (callArgs.length > 0 ? ", " : "") + callArgs.join(", ") + ")" + returnCaptureRight + ";" +
            " }; f;");

            return f.bind(block);
        }

        function rawFridaType(t) {
            return (t === 'object') ? 'pointer' : t;
        }

        function makeClassName() {
            for (let i = 1; true; i++) {
                const name = "FridaAnonymousClass" + i;
                if (!(name in classRegistry)) {
                    return name;
                }
            }
        }

        function objcMethodName(name) {
            return name.replace(/_/g, ":");
        }

        function jsMethodName(name) {
            let result = name.replace(/:/g, "_");
            if (objCObjectBuiltins.has(result))
                result += "2";
            return result;
        }

        function getMsgSendImpl(signature) {
            let impl = msgSendBySignatureId[signature.id];
            if (!impl) {
                const argTypes = signature.argTypes.map(function (t) { return t.type; });
                impl = new NativeFunction(api.objc_msgSend, signature.retType.type, argTypes);
                msgSendBySignatureId[signature.id] = impl;
            }

            return impl;
        }

        function getMsgSendSuperImpl(signature) {
            let impl = msgSendSuperBySignatureId[signature.id];
            if (!impl) {
                const argTypes = signature.argTypes.map(function (t) { return t.type; });
                impl = new NativeFunction(api.objc_msgSendSuper, signature.retType.type, argTypes);
                msgSendSuperBySignatureId[signature.id] = impl;
            }

            return impl;
        }

        function unparseSignature(retType, argTypes) {
            const frameSize = argTypes.length * pointerSize;
            return typeIdFromAlias(retType) + frameSize + argTypes.map(function (argType, i) {
                const frameOffset = (i * pointerSize);
                return typeIdFromAlias(argType) + frameOffset;
            }).join("");
        }

        function parseSignature(sig) {
            const cursor = [sig, 0];

            parseQualifiers(cursor);
            const retType = readType(cursor);
            readNumber(cursor);

            const argTypes = [];

            let id = retType.type;

            while (dataAvailable(cursor)) {
                parseQualifiers(cursor);
                const argType = readType(cursor);
                readNumber(cursor);
                argTypes.push(argType);

                id += argType.type;
            }

            return {
                id: id,
                retType: retType,
                argTypes: argTypes
            };
        }

        function readType(cursor) {
            while (true) {
                let id = readChar(cursor);
                if (id === '@') {
                    let next = peekChar(cursor);
                    if (next === '?') {
                        id += next;
                        skipChar(cursor);
                    } else if (next === '"') {
                        skipChar(cursor);
                        readUntil('"', cursor);
                        skipChar(cursor); // '"'
                    }
                }

                const type = singularTypeById[id];
                if (type !== undefined) {
                    return type;
                } else if (id === '[') {
                    const length = readNumber(cursor);
                    const elementType = readType(cursor);
                    skipChar(cursor); // ']'
                    return arrayType(length, elementType);
                } else if (id === '{') {
                    readUntil('=', cursor);
                    const structFields = [];
                    do {
                        structFields.push(readType(cursor));
                    } while (peekChar(cursor) !== '}');
                    skipChar(cursor); // '}'
                    return structType(structFields);
                } else if (id === '(') {
                    readUntil('=', cursor);
                    const unionFields = [];
                    do {
                        unionFields.push(readType(cursor));
                    } while (peekChar(cursor) !== '}');
                    skipChar(cursor); // ')'
                    return unionType(unionFields);
                } else if (id === 'b') {
                    readNumber(cursor);
                    return singularTypeById.i;
                } else if (id === '^') {
                    readType(cursor);
                    return singularTypeById['?'];
                } else {
                    throw new Error("Unable to handle type " + id);
                }
            }
        }

        function readNumber(cursor) {
            let result = "";
            while (dataAvailable(cursor)) {
                const c = peekChar(cursor);
                const v = c.charCodeAt(0);
                const isDigit = v >= 0x30 && v <= 0x39;
                if (isDigit) {
                    result += c;
                    skipChar(cursor);
                } else {
                    break;
                }
            }
            return parseInt(result);
        }

        function readUntil(token, cursor) {
            const buffer = cursor[0];
            const offset = cursor[1];
            const index = buffer.indexOf(token, offset);
            if (index === -1)
                throw new Error("Expected token '" + token + "' not found");
            const result = buffer.substring(offset, index);
            cursor[1] = index + 1;
            return result;
        }

        function readChar(cursor) {
            return cursor[0][cursor[1]++];
        }

        function peekChar(cursor) {
            return cursor[0][cursor[1]];
        }

        function skipChar(cursor) {
            cursor[1]++;
        }

        function dataAvailable(cursor) {
            return cursor[1] !== cursor[0].length;
        }

        const qualifierById = {
            'r': 'const',
            'n': 'in',
            'N': 'inout',
            'o': 'out',
            'O': 'bycopy',
            'R': 'byref',
            'V': 'oneway'
        };

        function parseQualifiers(cursor) {
            const qualifiers = [];
            while (true) {
                const q = qualifierById[peekChar(cursor)];
                if (q === undefined)
                    break;
                qualifiers.push(q);
                skipChar(cursor);
            }
            return qualifiers;
        }

        const idByAlias = {
            'char': 'c',
            'int': 'i',
            'int16': 's',
            'int32': 'l',
            'int64': 'q',
            'uchar': 'C',
            'uint': 'I',
            'uint16': 'S',
            'uint32': 'L',
            'uint64': 'Q',
            'float': 'f',
            'double': 'd',
            'bool': 'B',
            'void': 'v',
            'string': '*',
            'object': '@',
            'block': '@?',
            'class': '#',
            'selector': ':'
        };

        function typeIdFromAlias(alias) {
            const id = idByAlias[alias];
            if (id === undefined)
                throw new Error("No known encoding for type " + alias);
            return id;
        }

        const fromNativeId = function (h) {
            if (h.isNull()) {
                return null;
            } else if (h.toString(16) === this.handle.toString(16)) {
                return this;
            } else {
                return new ObjCObject(h);
            }
        };

        const toNativeId = function (v) {
            if (v === null) {
                return NULL;
            } else if (typeof v === 'string') {
                if (cachedNSString === null) {
                    cachedNSString = classRegistry.NSString;
                    cachedNSStringCtor = cachedNSString.stringWithUTF8String_;
                }
                return cachedNSStringCtor.call(cachedNSString, Memory.allocUtf8String(v));
            }
            return v;
        };

        const fromNativeBlock = function (h) {
            if (h.isNull()) {
                return null;
            } else if (h.toString(16) === this.handle.toString(16)) {
                return this;
            } else {
                return new Block(h);
            }
        };

        const toNativeBlock = function (v) {
            return (v !== null) ? v : NULL;
        };

        function arrayType(length, elementType) {
            return {
                type: 'pointer'
            };
        }

        function structType(fieldTypes) {
            let fromNative, toNative;

            if (fieldTypes.some(function (t) { return !!t.fromNative; })) {
                const fromTransforms = fieldTypes.map(function (t) {
                    if (t.fromNative)
                        return t.fromNative;
                    else
                        return identityTransform;
                });
                fromNative = function (v) {
                    return v.map(function (e, i) {
                        return fromTransforms[i].call(this, e);
                    });
                };
            } else {
                fromNative = identityTransform;
            }

            if (fieldTypes.some(function (t) { return !!t.toNative; })) {
                const toTransforms = fieldTypes.map(function (t) {
                    if (t.toNative)
                        return t.toNative;
                    else
                        return identityTransform;
                });
                toNative = function (v) {
                    return v.map(function (e, i) {
                        return toTransforms[i].call(this, e);
                    });
                };
            } else {
                toNative = identityTransform;
            }

            return {
                type: fieldTypes.map(function (t) {
                    return t.type;
                }),
                size: fieldTypes.reduce(function (totalSize, t) {
                    return totalSize + t.size;
                }, 0),
                fromNative: fromNative,
                toNative: toNative
            };
        }

        function unionType(fieldTypes) {
            const largestType = fieldTypes.reduce(function (largest, t) {
                if (t.size > largest.size)
                    return t;
                else
                    return largest;
            }, fieldTypes[0]);

            let fromNative, toNative;

            if (largestType.fromNative) {
                const fromTransform = largestType.fromNative;
                fromNative = function (v) {
                    return [fromTransform.call(this, v)];
                };
            } else {
                fromNative = function (v) {
                    return [v];
                };
            }

            if (largestType.toNative) {
                const toTransform = largestType.toNative;
                toNative = function (v) {
                    return [toTransform.call(this, v)];
                };
            } else {
                toNative = function (v) {
                    return [v];
                };
            }

            return {
                type: [largestType.type],
                size: largestType.size,
                fromNative: fromNative,
                toNative: toNative
            };
        }

        const singularTypeById = {
            'c': {
                type: 'char',
                size: 1,
                toNative: function (v) {
                    if (typeof v === 'boolean') {
                        return v ? 1 : 0;
                    }
                    return v;
                }
            },
            'i': {
                type: 'int',
                size: 4
            },
            's': {
                type: 'int16',
                size: 2
            },
            'l': {
                type: 'int32',
                size: 4
            },
            'q': {
                type: 'int64',
                size: 8
            },
            'C': {
                type: 'uchar',
                size: 1
            },
            'I': {
                type: 'uint',
                size: 4
            },
            'S': {
                type: 'uint16',
                size: 2
            },
            'L': {
                type: 'uint32',
                size: 4
            },
            'Q': {
                type: 'uint64',
                size: 8
            },
            'f': {
                type: 'float',
                size: 4
            },
            'd': {
                type: 'double',
                size: 8
            },
            'B': {
                type: 'bool',
                size: 1,
                fromNative: function (v) {
                    return v ? true : false;
                },
                toNative: function (v) {
                    return v ? 1 : 0;
                }
            },
            'v': {
                type: 'void',
                size: 0
            },
            '*': {
                type: 'pointer',
                size: pointerSize,
                fromNative: function (h) {
                    if (h.isNull()) {
                        return null;
                    }
                    return Memory.readUtf8String(h);
                }
            },
            '@': {
                type: 'pointer',
                size: pointerSize,
                fromNative: fromNativeId,
                toNative: toNativeId
            },
            '@?': {
                type: 'pointer',
                size: pointerSize,
                fromNative: fromNativeBlock,
                toNative: toNativeBlock
            },
            '#': {
                type: 'pointer',
                size: pointerSize,
                fromNative: fromNativeId,
                toNative: toNativeId
            },
            ':': {
                type: 'pointer',
                size: pointerSize
            },
            '?': {
                type: 'pointer',
                size: pointerSize
            }
        };

        function identityTransform(v) {
            return v;
        }
    }

    function getApi() {
        if (_api !== null) {
            return _api;
        }

        const temporaryApi = {};
        const pending = [
            {
                module: "libsystem_malloc.dylib",
                functions: {
                    "free": ['void', ['pointer']]
                }
            }, {
                module: "libobjc.A.dylib",
                functions: {
                    "objc_msgSend": function (address) {
                        this.objc_msgSend = address;
                    },
                    "objc_msgSendSuper": function (address) {
                        this.objc_msgSendSuper = address;
                    },
                    "objc_getClassList": ['int', ['pointer', 'int']],
                    "objc_lookUpClass": ['pointer', ['pointer']],
                    "objc_allocateClassPair": ['pointer', ['pointer', 'pointer', 'pointer']],
                    "objc_disposeClassPair": ['void', ['pointer']],
                    "objc_registerClassPair": ['void', ['pointer']],
                    "class_isMetaClass": ['bool', ['pointer']],
                    "class_getName": ['pointer', ['pointer']],
                    "class_copyProtocolList": ['pointer', ['pointer', 'pointer']],
                    "class_copyMethodList": ['pointer', ['pointer', 'pointer']],
                    "class_getClassMethod": ['pointer', ['pointer', 'pointer']],
                    "class_getInstanceMethod": ['pointer', ['pointer', 'pointer']],
                    "class_getSuperclass": ['pointer', ['pointer']],
                    "class_addProtocol": ['bool', ['pointer', 'pointer']],
                    "class_addMethod": ['bool', ['pointer', 'pointer', 'pointer', 'pointer']],
                    "objc_getProtocol": ['pointer', ['pointer']],
                    "objc_copyProtocolList": ['pointer', ['pointer']],
                    "protocol_getName": ['pointer', ['pointer']],
                    "protocol_copyMethodDescriptionList": ['pointer', ['pointer', 'bool', 'bool', 'pointer']],
                    "protocol_copyPropertyList": ['pointer', ['pointer', 'pointer']],
                    "protocol_copyProtocolList": ['pointer', ['pointer', 'pointer']],
                    "object_isClass": ['bool', ['pointer']],
                    "object_getClass": ['pointer', ['pointer']],
                    "object_getClassName": ['pointer', ['pointer']],
                    "method_getName": ['pointer', ['pointer']],
                    "method_getTypeEncoding": ['pointer', ['pointer']],
                    "method_getImplementation": ['pointer', ['pointer']],
                    "method_setImplementation": ['pointer', ['pointer', 'pointer']],
                    "property_getName": ['pointer', ['pointer']],
                    "property_copyAttributeList": ['pointer', ['pointer', 'pointer']],
                    "sel_getName": ['pointer', ['pointer']],
                    "sel_registerName": ['pointer', ['pointer']],
                    "class_getInstanceSize": ['pointer', ['pointer']]
                },
                optionals: {
                    "object_isClass": 'iOS8'
                }
            }, {
                module: "libdispatch.dylib",
                functions: {
                    "dispatch_async_f": ['void', ['pointer', 'pointer', 'pointer']]
                },
                variables: {
                    "_dispatch_main_q": function (address) {
                        this._dispatch_main_q = address;
                    }
                }
            }
        ];
        let remaining = 0;
        pending.forEach(function (api) {
            const isObjCApi = api.module === 'libobjc.A.dylib';
            const functions = api.functions || {};
            const variables = api.variables || {};
            const optionals = api.optionals || {};

            remaining += Object.keys(functions).length + Object.keys(variables).length;

            const exportByName = Module
            .enumerateExportsSync(api.module)
            .reduce(function (result, exp) {
                result[exp.name] = exp;
                return result;
            }, {});

            Object.keys(functions)
            .forEach(function (name) {
                const exp = exportByName[name];
                if (exp !== undefined && exp.type === 'function') {
                    const signature = functions[name];
                    if (typeof signature === 'function') {
                        signature.call(temporaryApi, exp.address);
                        if (isObjCApi)
                            signature.call(cachedObjCApi, exp.address);
                    } else {
                        temporaryApi[name] = new NativeFunction(exp.address, signature[0], signature[1]);
                        if (isObjCApi)
                            cachedObjCApi[name] = temporaryApi[name];
                    }
                    remaining--;
                } else {
                    const optional = optionals[name];
                    if (optional)
                        remaining--;
                }
            });

            Object.keys(variables)
            .forEach(function (name) {
                const exp = exportByName[name];
                if (exp !== undefined && exp.type === 'variable') {
                    const handler = variables[name];
                    handler.call(temporaryApi, exp.address);
                    remaining--;
                }
            });
        });
        if (remaining === 0) {
            _api = temporaryApi;
        }

        return _api;
    }
})();
