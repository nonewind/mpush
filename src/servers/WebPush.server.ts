import { Context } from "../Context";
import * as WebPush from "web-push"
import { ServerSocketPacket, MessageServerSocketPacket, InfoServerSocketPacket } from "../model/ServerSocketPacket";
import { Client } from "../model/Client";
import { Message } from "../model/Message.model";
import { Ebus } from "../Ebus";
export class WebPushServer {

  private nameMap: Map<string, WebPushClient> = new Map()
  private options: WebPush.RequestOptions | undefined = this.context.config.webpush.proxy ? { proxy: this.context.config.webpush.proxy } : undefined

  constructor(
    private readonly context: Context
  ) {
    if (this.context.config.webpush.apiKey) {
      WebPush.setVapidDetails(
        'mailto:your-email@gmail.com',
        this.context.config.webpush.vapidKeys.publicKey,
        this.context.config.webpush.vapidKeys.privateKey
      )
      WebPush.setGCMAPIKey(this.context.config.webpush.apiKey)
      this.context.ebus.on('register-webpush', ({ client, pushSubscription }) => {
        this.registerWebPush(client, pushSubscription)
      })
      this.context.ebus.on('message-start', (message) => {
        this.onMessageStart(message)
      })
      this.context.ebus.on('message-client-status', ({ name, mid, status }) => {
        this.onMessageClientStatus(name, mid, status)
      })
      console.log(`[WebPush-Server] Init`)
      this.context.ebus.on('message-webpush-callback', ({ mid, name }) => {
        this.onMessageWebPushCallback(mid, name)
      })
    } else {
      this.context.ebus.on('register-webpush', ({ client }) => {
        client.sendPacket(new InfoServerSocketPacket("服务端未提供webpush.apiKey"))
      })
    }
  }

  registerWebPush(client: Client, pushSubscription: WebPush.PushSubscription) {
    if (!this.nameMap.has(client.name)) {
      console.log(`[register-WebPush]: ${client.name}`)
    }
    this.nameMap.set(client.name, new WebPushClient(
      pushSubscription,
      this.context.config.webpush.retryTimeout,
      client.name,
      client.group,
      this.context.ebus,
      this.options
    ))
  }

  onMessageStart(message: Message) {
    if (message.sendType === 'personal') {
      const webpushClient = this.nameMap.get(message.target)
      if (webpushClient) {
        webpushClient.sendMessage(message)
        // this.context.ebus.emit('message-client-status', {
        //   mid: message.mid,
        //   name: webpushClient.name,
        //   status: 'webpush-wait'
        // })
        // webpushClient.sendPacket(new MessageServerSocketPacket(message)).then(() => {
        //   this.context.ebus.emit('message-client-status', {
        //     mid: message.mid,
        //     name: webpushClient.name,
        //     status: 'webpush'
        //   })
        // }).catch((e) => {
        //   console.log(`[WebPush Error]: ${e.message}`)
        // })
      }
    } else if (message.sendType === 'group') {
      this.nameMap.forEach((webpushClient) => {
        if (webpushClient.group && webpushClient.group === message.target) {
          webpushClient.sendMessage(message)
          // this.context.ebus.emit('message-client-status', {
          //   mid: message.mid,
          //   name: webpushClient.name,
          //   status: 'webpush-wait'
          // })
          // webpushClient.sendPacket(new MessageServerSocketPacket(message)).then(() => {
          //   this.context.ebus.emit('message-client-status', {
          //     mid: message.mid,
          //     name: webpushClient.name,
          //     status: 'webpush'
          //   })
          // }).catch((e) => {
          //   console.log(`[WebPush Error]: ${e.message}`)
          // })
        }
      })
    }
  }

  /**
   * 判断该message是否有通过WebPushClient发送  
   * 如是且状态为ok,则调用webpushClient.comfirm
   * @param message 
   * @param status 
   */
  private onMessageClientStatus(name: string, mid: string, status: MessageStatus): void {
    if (status === 'ok') {
      let webpushClient = this.nameMap.get(name)
      if (webpushClient) {
        console.log(`[WebPush client comfirm:Status change]: ${name}`)
        webpushClient.comfirm({ mid })
      }
    }
  }
  /**
   * WebPush送达回调指令事件
   * @param mid 
   * @param name 
   */
  onMessageWebPushCallback(mid: string, name: string) {
    let webpushClient = this.nameMap.get(name)
    if (webpushClient) {
      console.log(`[WebPush client comfirm:message-webpush-callback]: ${name}`)
      this.context.ebus.emit('message-client-status', {
        mid,
        name,
        status: 'webpush-ok-comfirm'
      })
    }
  }
}

class WebPushClient extends Client {
  private sendPacketLock: boolean = false
  constructor(
    private pushSubscription: WebPush.PushSubscription,
    retryTimeout: number,
    name: string,
    group: string,
    private ebus: Ebus,
    private options?: WebPush.RequestOptions,
  ) {
    super(retryTimeout, name, group)
  }
  protected send(message: Message) {
    if (!this.sendPacketLock) {
      this.sendPacketLock = true
      console.log(`[WebPush loop send]: ${message.message.text}`)
      this.ebus.emit('message-client-status', {
        mid: message.mid,
        name: this.name,
        status: 'webpush-wait'
      })

      let packet = new MessageServerSocketPacket(message)
      this.sendPacket(packet).then(() => {
        this.ebus.emit('message-client-status', {
          mid: packet.data.mid,
          name: this.name,
          status: 'webpush-ok'
        })
        this.comfirm({ mid: packet.data.mid })
      }).catch((e) => {
        console.log(`[WebPush send error]: ${e.message}`)
      }).finally(() => {
        this.sendPacketLock = false
      })
    }

  }
  sendPacket(packet: ServerSocketPacket): Promise<WebPush.SendResult> {
    return WebPush.sendNotification(this.pushSubscription, JSON.stringify(packet), {
      headers: {
        "Urgency": 'high'
      },
      ...this.options
    })
  }
  unregister() { }
}