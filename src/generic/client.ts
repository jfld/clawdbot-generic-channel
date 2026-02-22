// WebSocket 服务器和客户端类型，来自于 ws 库
import { WebSocketServer, WebSocket, type RawData } from "ws";

// HTTP 服务器类型定义
import type { Server as HTTPServer } from "http";

// 本地类型定义：通道配置、WebSocket 事件、入站消息
import type { GenericChannelConfig, WSEvent, InboundMessage } from "./types.js";

/**
 * WebSocket 客户端连接管理器
 * 负责管理 WebSocket 服务器和所有客户端连接
 * 提供消息收发、心跳检测、连接状态管理等功能
 */
export class GenericWSManager {
  // WebSocket 服务器实例
  private wss: WebSocketServer | null = null;
  
  // 客户端连接映射表：chatId -> WebSocket 实例
  private clients: Map<string, WebSocket> = new Map();
  
  // 关联的 HTTP 服务器实例（可选）
  private httpServer: HTTPServer | null = null;
  
  // 心跳检测定时器
  private heartbeatInterval: NodeJS.Timeout | null = null;

  /**
   * 构造函数
   * @param config - 通用通道配置对象
   */
  constructor(private config: GenericChannelConfig) {}

  /**
   * 启动 WebSocket 服务器
   * 可以附加到现有的 HTTP 服务器，或者创建独立的 WebSocket 服务器
   * @param httpServer - 可选的 HTTP 服务器实例
   */
  start(httpServer?: HTTPServer): void {
    // 获取配置中的端口号，默认为 8080
    const port = this.config.wsPort ?? 8080;
    // 获取配置中的 WebSocket 路径，默认为 /ws
    const path = this.config.wsPath ?? "/ws";

    if (httpServer) {
      // 附加到现有的 HTTP 服务器
      this.httpServer = httpServer;
      this.wss = new WebSocketServer({ server: httpServer, path });
    } else {
      // 创建独立的 WebSocket 服务器
      this.wss = new WebSocketServer({ port, path });
    }

    // 处理新的 WebSocket 连接
    this.wss.on("connection", (ws: WebSocket, req) => {
      // 从 URL 中提取 chatId
      const chatId = this.extractChatId(req.url || "");
      console.log(`[generic] WebSocket client connected: ${chatId}`);

      // 将客户端连接保存到映射表中
      if (chatId) {
        this.clients.set(chatId, ws);
      }

      // 处理接收到的消息
      ws.on("message", (data: RawData) => {
        this.handleMessage(ws, chatId, data);
      });

      // 处理连接关闭事件
      ws.on("close", () => {
        console.log(`[generic] WebSocket client disconnected: ${chatId}`);
        // 从映射表中移除断开的客户端
        if (chatId) {
          this.clients.delete(chatId);
        }
      });

      // 处理错误事件
      ws.on("error", (err) => {
        console.error(`[generic] WebSocket error for ${chatId}:`, err);
      });

      // 发送连接确认事件
      this.sendEvent(ws, {
        type: "connection.open",
        data: { chatId, timestamp: Date.now() },
      });
    });

    // 启动心跳检测
    this.startHeartbeat();

    console.log(`[generic] WebSocket server started on ${httpServer ? "attached server" : `port ${port}`} at path ${path}`);
  }

  /**
   * 停止 WebSocket 服务器
   * 清理所有连接和定时器
   */
  stop(): void {
    // 清除心跳检测定时器
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // 关闭 WebSocket 服务器
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // 清空所有客户端连接
    this.clients.clear();
  }

  /**
   * 从 URL 中提取 chatId
   * 支持从查询参数中获取 chatId 值
   * @param url - WebSocket 连接 URL
   * @returns 提取到的 chatId，如果不存在则生成一个基于时间戳的默认 ID
   */
  private extractChatId(url: string): string {
    // 使用正则表达式匹配 URL 中的 chatId 参数
    const match = url.match(/[?&]chatId=([^&]+)/);
    // 如果找到则解码并返回，否则生成默认 ID
    return match ? decodeURIComponent(match[1]) : `client-${Date.now()}`;
  }

  /**
   * 处理接收到的 WebSocket 消息
   * 解析 JSON 消息并根据事件类型进行相应处理
   * @param ws - WebSocket 连接实例
   * @param chatId - 客户端 chatId
   * @param data - 接收到的原始数据
   */
  private handleMessage(ws: WebSocket, chatId: string, data: RawData): void {
    try {
      console.log(`[generic] Received message from ${chatId}: ${data.toString()}`);
      // 将接收到的数据解析为 WSEvent 对象
      const message = JSON.parse(data.toString()) as WSEvent;

      // 根据事件类型进行处理
      if (message.type === "message.receive") {
        // 收到消息事件，转发到消息处理回调
        this.onMessageReceive?.(message.data as InboundMessage);
      } else if (message.type === "typing") {
        // 收到输入状态指示器（可选功能）
        console.log(`[generic] Typing indicator from ${chatId}`);
      }
    } catch (err) {
      // 解析失败，记录错误日志
      console.error(`[generic] Failed to parse message from ${chatId}:`, err);
    }
  }

  /**
   * 发送 WebSocket 事件到客户端
   * 将事件对象序列化为 JSON 后发送
   * @param ws - WebSocket 连接实例
   * @param event - 要发送的事件对象
   */
  private sendEvent(ws: WebSocket, event: WSEvent): void {
    // 只有在连接处于打开状态时才发送
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  /**
   * 启动心跳检测
   * 定期向所有客户端发送 ping 以检测连接状态
   * 移除已断开的客户端连接
   */
  private startHeartbeat(): void {
    // 每 30 秒执行一次心跳检测
    this.heartbeatInterval = setInterval(() => {
      this.clients.forEach((ws, chatId) => {
        // 如果连接仍然打开，发送 ping
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          // 连接已关闭，从映射表中移除
          this.clients.delete(chatId);
        }
      });
    }, 30000); // 30 seconds
  }

  // ==================== 公开 API ====================

  /**
   * 消息接收回调函数
   * 当收到客户端消息时调用此回调
   * @param message - 入站消息对象
   */
  onMessageReceive?: (message: InboundMessage) => void;

  /**
   * 发送事件到指定客户端
   * @param chatId - 目标客户端的 chatId
   * @param event - 要发送的事件对象
   * @returns 是否发送成功
   */
  sendToClient(chatId: string, event: WSEvent): boolean {
    const ws = this.clients.get(chatId);
    // 检查客户端是否存在且连接处于打开状态
    if (ws && ws.readyState === WebSocket.OPEN) {
      this.sendEvent(ws, event);
      return true;
    }
    return false;
  }

  /**
   * 广播事件到所有已连接的客户端
   * @param event - 要广播的事件对象
   */
  broadcast(event: WSEvent): void {
    this.clients.forEach((ws) => {
      this.sendEvent(ws, event);
    });
  }

  /**
   * 检查客户端是否已连接
   * @param chatId - 要检查的客户端 chatId
   * @returns 是否已连接
   */
  isClientConnected(chatId: string): boolean {
    const ws = this.clients.get(chatId);
    return ws !== undefined && ws.readyState === WebSocket.OPEN;
  }

  /**
   * 获取所有已连接的客户端列表
   * @returns 客户端 chatId 数组
   */
  getConnectedClients(): string[] {
    return Array.from(this.clients.keys());
  }
}

// ==================== 单例模式导出 ====================

// 单例实例变量
let wsManager: GenericWSManager | null = null;

/**
 * 创建或获取通用 WebSocket 管理器单例
 * 如果已存在则返回现有实例，否则创建新实例
 * @param config - 通道配置对象
 * @returns GenericWSManager 实例
 */
export function createGenericWSManager(config: GenericChannelConfig): GenericWSManager {
  if (!wsManager) {
    wsManager = new GenericWSManager(config);
  }
  return wsManager;
}

/**
 * 获取当前的管理器实例
 * @returns 现有的 GenericWSManager 实例，如果未创建则返回 null
 */
export function getGenericWSManager(): GenericWSManager | null {
  return wsManager;
}

/**
 * 销毁管理器实例
 * 停止服务器并释放资源
 */
export function destroyGenericWSManager(): void {
  if (wsManager) {
    wsManager.stop();
    wsManager = null;
  }
}
