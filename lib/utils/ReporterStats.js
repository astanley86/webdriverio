import merge from 'deepmerge'
import crypto from 'crypto'
import sanitize from '../helpers/sanitize'

class RunnableStats {
    constructor (type) {
        this.type = type
        this.start = new Date()
        this._duration = 0
    }

    complete () {
        this.end = new Date()
        this._duration = this.end - this.start
    }

    get duration () {
        if (this.end) {
            return this._duration
        }
        return new Date() - this.start
    }
}

class RunnerStats extends RunnableStats {
    constructor (runner) {
        super('runner')
        this.cid = runner.cid
        this.capabilities = runner.capabilities
        this.sanitizedCapabilities = runner.capabilities && sanitize.caps(runner.capabilities)
        this.config = runner.config
        this.specs = {}
    }
}

class SpecStats extends RunnableStats {
    constructor (runner) {
        super('spec')
        this.files = runner.specs
        this.specHash = runner.specHash
        this.suites = {}
        this.output = []
    }
}

class SuiteStats extends RunnableStats {
    constructor (runner) {
        super('suite')
        this.title = runner.title
        this.tests = {}
        this.hooks = {}
    }
}

class TestStats extends RunnableStats {
    constructor (runner) {
        super('test')
        this.title = runner.title
        this.state = ''
        this.screenshots = []
        this.output = []
    }
}

class HookStats extends RunnableStats {
    constructor (runner) {
        super('hook')
        this.title = runner.title
        this.parent = runner.parent
        this.currentTest = runner.currentTest
    }
}

class ReporterStats extends RunnableStats {
    constructor () {
        super('base')

        this.counts = {
            suites: 0,
            tests: 0,
            hooks: 0,
            passes: 0,
            pending: 0,
            failures: 0
        }
        this.runners = {}
        this.failures = []
    }

    getCounts () {
        return this.counts
    }

    getFailures () {
        return this.failures.map((test) => {
            test.runningBrowser = ''
            for (let pid of Object.keys(test.runner)) {
                let caps = test.runner[pid]
                test.runningBrowser += '\nrunning'

                if (caps.browserName) {
                    test.runningBrowser += ` ${caps.browserName}`
                }
                if (caps.version) {
                    test.runningBrowser += ` (v${caps.version})`
                }
                if (caps.platform) {
                    test.runningBrowser += ` on ${caps.platform}`
                }

                const host = this.runners[pid].config.host
                if (host && host.indexOf('saucelabs') > -1) {
                    test.runningBrowser += '\nCheck out job at https://saucelabs.com/tests/' + this.runners[pid].sessionID
                }
            }
            return test
        })
    }

    runnerStart (runner) {
        if (!this.runners[runner.cid]) {
            this.runners[runner.cid] = new RunnerStats(runner)
        }
    }

    getRunnerStats (runner) {
        if (!this.runners[runner.cid]) throw Error(`Unrecognised runner [${runner.cid}]`)
        return this.runners[runner.cid]
    }

    getSpecHash (runner) {
        if (!runner.specHash) {
            if (!runner.specs) throw Error('Cannot generate spec hash for runner with no \'specs\' key')
            runner.specHash = crypto.createHash('md5')
                .update(runner.specs.join(''))
                .digest('hex')
        }
        return runner.specHash
    }

    specStart (runner) {
        const specHash = this.getSpecHash(runner)
        this.getRunnerStats(runner).specs[specHash] = new SpecStats(runner)
    }

    getSpecStats (runner) {
        const runnerStats = this.getRunnerStats(runner)
        const specHash = this.getSpecHash(runner)
        if (!runnerStats.specs[specHash]) throw Error(`Unrecognised spec [${specHash}] for runner [${runner.cid}]`)
        return runnerStats.specs[specHash]
    }

    setSessionId (runner) {
        this.getRunnerStats(runner).sessionID = runner.sessionID
    }

    suiteStart (runner) {
        this.getSpecStats(runner).suites[runner.title] = new SuiteStats(runner)
        this.counts.suites++
    }

    getSuiteStats (runner, suiteTitle) {
        let specStats = this.getSpecStats(runner)

        /**
         * if error occurs in root level hooks we haven't created any suites yet, so
         * create one here if so
         */
        if (!specStats.suites[suiteTitle]) {
            this.suiteStart(merge(runner, { title: runner.parent }))
            specStats = this.getSpecStats(runner)
        }

        return specStats.suites[suiteTitle]
    }

    hookStart (runner) {
        const suiteStat = this.getSuiteStats(runner, runner.parent)

        if (!suiteStat) {
            return
        }

        suiteStat.hooks[runner.title] = new HookStats(runner)
    }

    hookEnd (runner) {
        const hookStats = this.getHookStats(runner)

        if (!hookStats) {
            return
        }

        hookStats.complete()
        this.counts.hooks++
    }

    testStart (runner) {
        this.getSuiteStats(runner, runner.parent).tests[runner.title] = new TestStats(runner)
    }
    getHookStats (runner) {
        const suiteStats = this.getSuiteStats(runner, runner.parent)

        if (!suiteStats) {
            return
        }

        // Errors encountered inside hooks (e.g. beforeEach) can be identified by looking
        // at the currentTest param (currently only applicable to the Mocha adapter).
        let title = runner.title
        if (!suiteStats.hooks[title]) {
            title = runner.title
        }

        if (!suiteStats.hooks[title]) throw Error(`Unrecognised hook [${title}] for suite [${runner.parent}]`)
        return suiteStats.hooks[title]
    }
    getTestStats (runner) {
        const suiteStats = this.getSuiteStats(runner, runner.parent)

        if (!suiteStats) {
            return
        }

        // Errors encountered inside hooks (e.g. beforeEach) can be identified by looking
        // at the currentTest param (currently only applicable to the Mocha adapter).
        let title = runner.currentTest || runner.title
        if (!suiteStats.tests[title]) {
            title = runner.title
        }

        if (!suiteStats.tests[title]) throw Error(`Unrecognised test [${title}] for suite [${runner.parent}]`)
        return suiteStats.tests[title]
    }

    output (type, runner) {
        runner.time = new Date()
        if (runner.title && runner.parent) {
            this.getTestStats(runner).output.push({
                type,
                payload: runner
            })
        } else {
            // Log commands, results and screenshots executed outside of a test
            this.getSpecStats(runner).output.push({
                type,
                payload: runner
            })
        }
    }

    testPass (runner) {
        this.getTestStats(runner).state = 'pass'
        this.counts.passes++
    }

    testPending (runner) {
        // Pending tests don't actually start, so won't yet be registered
        this.testStart(runner)
        this.testEnd(runner)
        this.getTestStats(runner).state = 'pending'
        this.counts.pending++
    }

    testFail (runner) {
        let testStats
        try {
            testStats = this.getTestStats(runner)
        } catch (e) {
            // If a test fails during the before() or beforeEach() hook, it will not yet
            // have been 'started', so start now
            this.testStart(runner)
            testStats = this.getTestStats(runner)
        }

        testStats.state = 'fail'
        testStats.error = runner.err
        this.counts.failures++

        /**
         * check if error also happened in other runners
         */
        let duplicateError = false
        for (let failure of this.failures) {
            if (runner.err.message !== failure.err.message || failure.title !== runner.title) {
                continue
            }
            duplicateError = true
            failure.runner[runner.cid] = runner.runner[runner.cid]
        }

        if (!duplicateError) {
            this.failures.push(runner)
        }
    }

    testEnd (runner) {
        this.getTestStats(runner).complete()
        this.counts.tests++
    }

    suiteEnd (runner) {
        this.getSuiteStats(runner, runner.title).complete()
    }

    runnerEnd (runner) {
        this.getSpecStats(runner).complete()
    }
}

export {
    RunnableStats,
    RunnerStats,
    SpecStats,
    SuiteStats,
    TestStats,
    ReporterStats
}
