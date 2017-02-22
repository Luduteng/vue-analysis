import config from './config'
import Dep from './observer/dep'
import { parseExpression } from './parsers/expression'
import { pushWatcher } from './batcher'
import {
  extend,
  warn,
  isArray,
  isObject,
  nextTick,
  _Set as Set
} from './util/index'

let uid = 0

/**
 * A watcher parses an expression, collects dependencies,
 * and fires callback when the expression value changes.
 * This is used for both the $watch() api and directives.
 *
 * @param {Vue} vm
 * @param {String|Function} expOrFn
 * @param {Function} cb
 * @param {Object} options
 *                 - {Array} filters
 *                 - {Boolean} twoWay
 *                 - {Boolean} deep
 *                 - {Boolean} user
 *                 - {Boolean} sync
 *                 - {Boolean} lazy
 *                 - {Function} [preProcess]
 *                 - {Function} [postProcess]
 * @constructor
 */

export default function Watcher (vm, expOrFn, cb, options) {
  // mix in options
  if (options) {
    extend(this, options)
  }
  var isFn = typeof expOrFn === 'function'
  this.vm = vm
  vm._watchers.push(this)
  this.expression = expOrFn
  // 把回调放在this上, 在完成了一轮的数据变动之后,在批处理最后阶段执行cb, cb一般是dom操作
  this.cb = cb
  this.id = ++uid // uid for batching
  this.active = true
  this.dirty = this.lazy // for lazy watchers
  // 用deps存储当前的依赖,而新一轮的依赖收集过程中收集到的依赖则会放到newDeps中
  // 之所以要用一个新的数组存放新的依赖是因为当依赖变动之后,
  // 比如由依赖a和b变成依赖a和c
  // 那么需要把原先的依赖订阅清除掉,也就是从b的subs数组中移除当前watcher,因为我已经不想监听b的变动
  // 所以我需要比对deps和newDeps,找出那些不再依赖的dep,然后dep.removeSub(当前watcher),这一步在afterGet中完成
  this.deps = []
  this.newDeps = []
  // 这两个set是用来提升比对过程的效率,不用set的话,判断deps中的一个dep是否在newDeps中的复杂度是O(n)
  // 改用set来判断的话,就是O(1)
  this.depIds = new Set()
  this.newDepIds = new Set()
  this.prevError = null // for async error stacks
  // parse expression for getter/setter
  if (isFn) {
    this.getter = expOrFn
    this.setter = undefined
  } else {
    // 把expression解析为一个对象,对象的get/set属性存放了获取/设置的函数
    // 比如hello解析的get函数为function(scope) {return scope.hello;}
    var res = parseExpression(expOrFn, this.twoWay)
    this.getter = res.get
    // 比如scope.a = {b: {c: 0}} 而expression为a.b.c
    // 执行res.set(scope, 123)能得到scope.a变成{b: {c: 0}}
    this.setter = res.set
  }
  // 执行get(),既拿到表达式的值,又完成第一轮的依赖收集,使得watcher订阅到相关的依赖
  this.value = this.lazy
    ? undefined
    : this.get()
  // state for avoiding false triggers for deep and Array
  // watchers during vm._digest()
  this.queued = this.shallow = false
}

/**
 * Evaluate the getter, and re-collect dependencies.
 */

Watcher.prototype.get = function () {
  // beforeGet就一行: Dep.target = this
  this.beforeGet()
  // v-for情况下,this.scope有值,是对应的数组元素
  var scope = this.scope || this.vm
  var value
  try {
    // 执行getter,这一步很精妙,表面上看是求出指令的初始值,
    // 其实也完成了初始的依赖收集操作,即:让当前的Watcher订阅到对应的依赖(Dep)
    // 比如a+b这样的expression实际是依赖两个a和b变量,this.getter的求值过程中
    // 会依次触发a 和 b的getter,在observer/index.js:defineReactive函数中,我们定义好了他们的getter
    // 他们的getter会将Dep.target也就是当前Watcher加入到自己的subs(订阅者数组)里
    value = this.getter.call(scope, scope)
  } catch (e) {
    if (
      process.env.NODE_ENV !== 'production' &&
      config.warnExpressionErrors
    ) {
      warn(
        'Error when evaluating expression ' +
        '"' + this.expression + '": ' + e.toString(),
        this.vm
      )
    }
  }
  // "touch" every property so they are all tracked as
  // dependencies for deep watching
  if (this.deep) {
    traverse(value)
  }
  if (this.preProcess) {
    value = this.preProcess(value)
  }
  if (this.filters) {
    value = scope._applyFilters(value, null, this.filters, false)
  }
  if (this.postProcess) {
    value = this.postProcess(value)
  }
  this.afterGet()
  return value
}

/**
 * Set the corresponding value with the setter.
 *
 * @param {*} value
 */

Watcher.prototype.set = function (value) {
  var scope = this.scope || this.vm
  if (this.filters) {
    value = scope._applyFilters(
      value, this.value, this.filters, true)
  }
  try {
    this.setter.call(scope, scope, value)
  } catch (e) {
    if (
      process.env.NODE_ENV !== 'production' &&
      config.warnExpressionErrors
    ) {
      warn(
        'Error when evaluating setter ' +
        '"' + this.expression + '": ' + e.toString(),
        this.vm
      )
    }
  }
  // two-way sync for v-for alias
  var forContext = scope.$forContext
  if (forContext && forContext.alias === this.expression) {
    if (forContext.filters) {
      process.env.NODE_ENV !== 'production' && warn(
        'It seems you are using two-way binding on ' +
        'a v-for alias (' + this.expression + '), and the ' +
        'v-for has filters. This will not work properly. ' +
        'Either remove the filters or use an array of ' +
        'objects and bind to object properties instead.',
        this.vm
      )
      return
    }
    forContext._withLock(function () {
      if (scope.$key) { // original is an object
        forContext.rawValue[scope.$key] = value
      } else {
        forContext.rawValue.$set(scope.$index, value)
      }
    })
  }
}

/**
 * Prepare for dependency collection.
 */

Watcher.prototype.beforeGet = function () {
  Dep.target = this
}

/**
 * Add a dependency to this directive.
 *
 * @param {Dep} dep
 */

Watcher.prototype.addDep = function (dep) {
  var id = dep.id
  // 如果newDepIds里已经有了这个Dep的id, 说明这一轮的依赖收集过程已经完成过这个依赖的处理了
  // 比如a + b + a这样的表达式,第二个a在get时就没必要在收集一次了
  if (!this.newDepIds.has(id)) {
    this.newDepIds.add(id)
    this.newDeps.push(dep)
    if (!this.depIds.has(id)) {
      // 如果连depIds里都没有,说明之前就没有收集过这个依赖,依赖的订阅者里面没有我这个Watcher,
      // 所以加进去
      // 一般发生在第一次依赖收集时
      dep.addSub(this)
    }
  }
}

/**
 * Clean up for dependency collection.
 */

Watcher.prototype.afterGet = function () {
  Dep.target = null
  var i = this.deps.length
  while (i--) {
    var dep = this.deps[i]
    if (!this.newDepIds.has(dep.id)) {
      dep.removeSub(this)
    }
  }
  var tmp = this.depIds
  this.depIds = this.newDepIds
  this.newDepIds = tmp
  this.newDepIds.clear()
  tmp = this.deps
  this.deps = this.newDeps
  this.newDeps = tmp
  this.newDeps.length = 0
}

/**
 * Subscriber interface.
 * Will be called when a dependency changes.
 *
 * @param {Boolean} shallow
 */

Watcher.prototype.update = function (shallow) {
  if (this.lazy) {
    this.dirty = true
  } else if (this.sync || !config.async) {
    this.run()
  } else {
    // if queued, only overwrite shallow with non-shallow,
    // but not the other way around.
    this.shallow = this.queued
      ? shallow
        ? this.shallow
        : false
      : !!shallow
    this.queued = true
    // record before-push error stack in debug mode
    /* istanbul ignore if */
    if (process.env.NODE_ENV !== 'production' && config.debug) {
      this.prevError = new Error('[vue] async stack trace')
    }
    pushWatcher(this)
  }
}

/**
 * Batcher job interface.
 * Will be called by the batcher.
 */

Watcher.prototype.run = function () {
  if (this.active) {
    var value = this.get()
    if (
      value !== this.value ||
      // Deep watchers and watchers on Object/Arrays should fire even
      // when the value is the same, because the value may
      // have mutated; but only do so if this is a
      // non-shallow update (caused by a vm digest).
      ((isObject(value) || this.deep) && !this.shallow)
    ) {
      // set new value
      var oldValue = this.value
      this.value = value
      // in debug + async mode, when a watcher callbacks
      // throws, we also throw the saved before-push error
      // so the full cross-tick stack trace is available.
      var prevError = this.prevError
      /* istanbul ignore if */
      if (process.env.NODE_ENV !== 'production' &&
          config.debug && prevError) {
        this.prevError = null
        try {
          this.cb.call(this.vm, value, oldValue)
        } catch (e) {
          nextTick(function () {
            throw prevError
          }, 0)
          throw e
        }
      } else {
        this.cb.call(this.vm, value, oldValue)
      }
    }
    this.queued = this.shallow = false
  }
}

/**
 * Evaluate the value of the watcher.
 * This only gets called for lazy watchers.
 */

Watcher.prototype.evaluate = function () {
  // avoid overwriting another watcher that is being
  // collected.
  var current = Dep.target
  this.value = this.get()
  this.dirty = false
  Dep.target = current
}

/**
 * Depend on all deps collected by this watcher.
 */

Watcher.prototype.depend = function () {
  var i = this.deps.length
  while (i--) {
    this.deps[i].depend()
  }
}

/**
 * Remove self from all dependencies' subcriber list.
 */

Watcher.prototype.teardown = function () {
  if (this.active) {
    // remove self from vm's watcher list
    // this is a somewhat expensive operation so we skip it
    // if the vm is being destroyed or is performing a v-for
    // re-render (the watcher list is then filtered by v-for).
    if (!this.vm._isBeingDestroyed && !this.vm._vForRemoving) {
      this.vm._watchers.$remove(this)
    }
    var i = this.deps.length
    while (i--) {
      this.deps[i].removeSub(this)
    }
    this.active = false
    this.vm = this.cb = this.value = null
  }
}

/**
 * Recrusively traverse an object to evoke all converted
 * getters, so that every nested property inside the object
 * is collected as a "deep" dependency.
 *
 * @param {*} val
 */

const seenObjects = new Set()
function traverse (val, seen) {
  let i, keys
  if (!seen) {
    seen = seenObjects
    seen.clear()
  }
  const isA = isArray(val)
  const isO = isObject(val)
  if ((isA || isO) && Object.isExtensible(val)) {
    if (val.__ob__) {
      var depId = val.__ob__.dep.id
      if (seen.has(depId)) {
        return
      } else {
        seen.add(depId)
      }
    }
    if (isA) {
      i = val.length
      while (i--) traverse(val[i], seen)
    } else if (isO) {
      keys = Object.keys(val)
      i = keys.length
      while (i--) traverse(val[keys[i]], seen)
    }
  }
}
