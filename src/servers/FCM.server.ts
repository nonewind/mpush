import { Context } from "../Context";
import { ServerSocketPacket, MessageServerSocketPacket, InfoServerSocketPacket } from "../model/ServerSocketPacket";
import { Client } from "../model/Client";
import { Message } from "../model/Message.model";
import { Ebus } from "../Ebus";
import * as HttpsProxyAgent from 'https-proxy-agent'
import Axios from 'axios'
const axios = Axios.create()

export class FCMServer {

  private nameMap: Map<string, FCMClient> = new Map()
  private readonly options: {
    serverKey: string,
    proxy: HttpsProxyAgent | undefined
  }

  constructor(
    private readonly context: Context
  ) {
    if (this.context.config.fcm.projectId && this.context.config.fcm.applicationId && this.context.config.fcm.apiKey && this.context.config.fcm.serverKey) {

      this.options = {
        serverKey: this.context.config.fcm.serverKey,
        proxy: undefined
      }
      if (this.context.config.fcm.proxy) {
        this.options.proxy = new HttpsProxyAgent(this.context.config.fcm.proxy);
      }

      this.context.ebus.on('register-fcm', ({ client, token }) => {
        this.registerFCM(client, token)
      })
      this.context.ebus.on('message-start', (message) => {
        this.onMessageStart(message)
      })
      this.context.ebus.on('message-client-status', ({ name, mid, status }) => {
        this.onMessageClientStatus(name, mid, status)
      })
      console.log(`[FCM-Server] Init`)
      this.context.ebus.on('message-fcm-callback', ({ mid, name }) => {
        this.onMessageFCMCallback(mid, name)
      })
    } else {
      this.context.ebus.on('register-fcm', ({ client }) => {
        client.sendPacket(new InfoServerSocketPacket("fcm.projectId或fcm.applicationId或fcm.apiKey或fcm.serverKey"))
      })
    }
  }

  registerFCM(client: Client, token: string) {
    if (this.nameMap.has(client.name)) {
      console.log(`[register-FCM-update]: ${client.name}`)
      this.nameMap.get(client.name)?.update(token)
    } else {
      console.log(`[register-FCM]: ${client.name}`)
      this.nameMap.set(client.name, new FCMClient(
        token,
        this.context.config.fcm.retryTimeout,
        client.name,
        client.group,
        this.context.ebus,
        this.options
      ))
    }
  }

  onMessageStart(message: Message) {
    if (message.sendType === 'personal') {
      const fcmClient = this.nameMap.get(message.target)
      if (fcmClient) {
        fcmClient.sendMessage(message)
      }
    } else if (message.sendType === 'group') {
      this.nameMap.forEach((fcmClient) => {
        if (fcmClient.group && fcmClient.group === message.target) {
          fcmClient.sendMessage(message)
        }
      })
    }
  }

  /**
   * 判断该message是否有通过FCMClient发送  
   * 如是且状态为ok,则调用fcmClient.comfirm
   * @param message 
   * @param status 
   */
  private onMessageClientStatus(name: string, mid: string, status: MessageStatus): void {
    if (status === 'ok') {
      let fcmClient = this.nameMap.get(name)
      if (fcmClient) {
        console.log(`[FCM client comfirm:Status change]: ${name}`)
        fcmClient.comfirm({ mid })
      }
    }
  }
  /**
   * FCM送达回调指令事件
   * @param mid 
   * @param name 
   */
  onMessageFCMCallback(mid: string, name: string) {
    let fcmClient = this.nameMap.get(name)
    if (fcmClient) {
      console.log(`[FCM client comfirm:message-fcm-callback]: ${name}`)
      this.context.ebus.emit('message-client-status', {
        mid,
        name,
        status: 'fcm-ok'
      })
    }
  }
}

class FCMClient extends Client {
  private sendPacketLock: boolean = false
  constructor(
    private token: string,
    retryTimeout: number,
    name: string,
    group: string,
    private ebus: Ebus,
    private options: {
      serverKey: string,
      proxy: HttpsProxyAgent | undefined
    },
  ) {
    super(retryTimeout, name, group)
  }
  protected send(message: Message) {
    if (!this.sendPacketLock) {
      this.sendPacketLock = true
      console.log(`[FCM loop send]: ${message.message.text}`)
      this.ebus.emit('message-client-status', {
        mid: message.mid,
        name: this.name,
        status: 'fcm-wait'
      })

      let packet = new MessageServerSocketPacket(message)
      this.sendPacket(packet).then(() => {
        this.ebus.emit('message-client-status', {
          mid: packet.data.mid,
          name: this.name,
          status: 'fcm-send'
        })
        this.comfirm({ mid: packet.data.mid })
      }).catch((e) => {
        console.log(`[FCM send error]: ${e.message}`)
      }).finally(() => {
        this.sendPacketLock = false
      })
    }

  }
  sendPacket(packet: ServerSocketPacket): Promise<void> {
    return axios.post('https://fcm.googleapis.com/fcm/send', {
      "data": packet,
      to: this.token
    }, {
      headers: {
        Authorization: `key=${this.options.serverKey}`
      },
      httpsAgent: this.options.proxy
    })
  }
  unregister() { }

  update(token: string) {
    this.token = token
  }
}