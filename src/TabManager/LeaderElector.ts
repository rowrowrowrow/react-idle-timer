import { timers } from '../utils/timers'
import { sleep } from '../utils/sleep'
import { createToken } from '../utils/token'

enum InternalContext {
  LEADER
}

enum InternalAction {
  APPLY,
  TELL,
  CLOSE
}

interface IInternalMessage {
  ctx: InternalContext
  action: InternalAction
  token: string
}

interface ILeaderElectorOptions {
  /**
   * How often renegotiation for leader will occur.
   *
   * @default 2000
   */
  fallbackInterval?: number

  /**
   * How long tab instances will have to respond.
   *
   * @default 100
   */
  responseTime?: number
}

export class LeaderElector {
  private options: ILeaderElectorOptions
  private channel: BroadcastChannel
  public token: string = createToken()

  public isLeader: boolean = false
  public isDead: boolean = false
  public isApplying: boolean = false

  private intervals: number[] = []
  private listeners: ((message: MessageEvent<IInternalMessage>) => void)[] = []

  public deferred: Promise<void>

  constructor (channel: any, options: ILeaderElectorOptions) {
    this.channel = channel
    this.options = options

    this.apply = this.apply.bind(this)
    this.awaitLeadership = this.awaitLeadership.bind(this)
    this.sendAction = this.sendAction.bind(this)
  }

  private async apply (): Promise<boolean> {
    if (this.isLeader) return false
    if (this.isDead) return false
    if (this.isApplying) return false
    this.isApplying = true

    let abort = false

    const handleMessage = (message: MessageEvent<IInternalMessage>) => {
      const { ctx, token, action } = message.data
      if (ctx === InternalContext.LEADER && token !== this.token) {
        // Other is applying
        if (action === InternalAction.APPLY) {
          // Other has higher token, stop applying
          if (token > this.token) {
            abort = true
          }
        }

        // Other is already leader
        if (action === InternalAction.TELL) {
          abort = true
        }
      }
    }

    this.channel.addEventListener('message', handleMessage)

    try {
      this.sendAction(InternalAction.APPLY)
      await sleep(this.options.responseTime)

      if (abort) throw new Error()
      this.sendAction(InternalAction.APPLY)

      this.assumeLead()

      this.channel.removeEventListener('message', handleMessage)
      this.isApplying = false
      return true
    } catch {
      return false
    }
  }

  private awaitLeadership (): Promise<void> {
    if (this.isLeader) return Promise.resolve()
    let resolved = false
    let interval = null

    return new Promise(resolve => {
      // Promise resolution
      const finish = () => {
        /**
         * istanbul ignore next
         *
         * Its hard to simulate this race condition in tests.
         * It should rarely be hit, but its good to have the
         * protection there just in case.
         */
        if (resolved) return
        resolved = true
        timers.clearInterval(interval)
        const index = this.intervals.indexOf(interval)
        this.intervals.splice(index, 1)
        this.channel.removeEventListener('message', onClose)
        resolve()
      }

      // Create leader polling
      interval = timers.setInterval(() => {
        this.apply().then(() => {
          if (this.isLeader) finish()
        })
      }, this.options.fallbackInterval)
      this.intervals.push(interval)

      // Try to assume leadership when another leader dies
      const onClose = (message: MessageEvent<IInternalMessage>) => {
        const { ctx, action } = message.data
        if (ctx === InternalContext.LEADER && action === InternalAction.CLOSE) {
          this.apply().then(() => {
            if (this.isLeader) finish()
          })
        }
      }
      this.channel.addEventListener('message', onClose)
    })
  }

  private sendAction (action: InternalAction): void {
    this.channel.postMessage({
      ctx: InternalContext.LEADER,
      action,
      token: this.token
    })
  }

  private assumeLead (): void {
    this.isLeader = true

    const isLeaderListener = (message: MessageEvent<IInternalMessage>) => {
      const { ctx, action } = message.data
      if (ctx === InternalContext.LEADER && action === InternalAction.APPLY) {
        this.sendAction(InternalAction.TELL)
      }
    }
    this.channel.addEventListener('message', isLeaderListener)
    this.listeners.push(isLeaderListener)
    return this.sendAction(InternalAction.TELL)
  }

  public waitForLeadership (): Promise<void> {
    if (this.deferred) return this.deferred
    this.deferred = this.awaitLeadership()
    return this.deferred
  }

  public close (): void {
    if (this.isDead) return
    this.isDead = true
    this.isLeader = false

    this.sendAction(InternalAction.CLOSE)

    this.listeners.forEach(listener => this.channel.removeEventListener('message', listener))
    this.intervals.forEach(interval => timers.clearInterval(interval))
  }
}
