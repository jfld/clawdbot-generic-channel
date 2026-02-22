// 通道出站适配器类型定义，来自于 openclaw 插件 SDK
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";

// 获取通用运行时实例，用于访问通道配置和工具方法
import { getGenericRuntime } from "./runtime.js";

// 发送消息和媒体的通用方法
import { sendMessageGeneric, sendMediaGeneric } from "./send.js";

/**
 * 通用通道出站适配器
 * 负责处理消息和媒体从系统发送到外部通道的逻辑
 * 实现 ChannelOutboundAdapter 接口，提供统一的发送能力
 */
export const genericOutbound: ChannelOutboundAdapter = {
  /**
   * 投递模式
   * "direct" 表示直接投递模式，消息会直接发送给接收者
   */
  deliveryMode: "direct",

  /**
   * 文本分块器函数
   * 用于将长文本分割成适合发送的小块
   * 使用 Markdown 格式进行分块，适合支持 Markdown 的通道
   * @param text - 要分割的文本
   * @param limit - 单个块的最大字符数限制
   * @returns 分割后的文本块数组
   */
  chunker: (text, limit) => getGenericRuntime().channel.text.chunkMarkdownText(text, limit),

  /**
   * 分块模式
   * "markdown" 表示使用 Markdown 格式进行分块
   */
  chunkerMode: "markdown",

  /**
   * 文本块大小限制
   * 单个文本块的最大字符数设为 4000
   */
  textChunkLimit: 4000,
  /**
   * 发送文本消息
   * 将文本消息发送给指定的接收者
   * @param cfg - 通道配置对象，包含认证信息等
   * @param to - 接收者标识
   * @param text - 要发送的文本内容
   * @returns 发送结果对象，包含通道标识和发送状态
   */
  sendText: async ({ cfg, to, text }) => {
    // 调用通用发送消息方法
    console.log(`发送文本消息cfg=${JSON.stringify(cfg)} to ${to}: ${text}`);
    const result = await sendMessageGeneric({ cfg, to, text });
    // 返回结果并添加通道标识
    return { channel: "generic-channel", ...result };
  },

  /**
   * 发送媒体消息
   * 可以发送图片、语音、音频等媒体内容
   * 支持带caption（说明文字）的媒体发送
   * 如果媒体类型不支持，会降级为发送文本+媒体URL
   * @param cfg - 通道配置对象
   * @param to - 接收者标识
   * @param text - 可选的说明文字（caption）
   * @param mediaUrl - 媒体文件的URL地址
   * @param mediaType - 媒体类型：image（图片）、voice（语音）、audio（音频）
   * @returns 发送结果对象
   */
  sendMedia: async ({ cfg, to, text, mediaUrl, mediaType }) => {
    console.log(`发送媒体消息cfg=${JSON.stringify(cfg)} to ${to}: text=${text} ,mediaUrl=${mediaUrl},mediaType=${mediaType}`);
    // 根据 mediaType 确定内容类型 - 保留语音和音频的区分
    let contentType: "image" | "voice" | "audio" | undefined;
    
    if (mediaType === "image") {
      contentType = "image";
    } else if (mediaType === "voice") {
      contentType = "voice";
    } else if (mediaType === "audio") {
      contentType = "audio";
    }

    // 如果存在有效的 contentType 和 mediaUrl，则发送媒体
    if (contentType && mediaUrl) {
      const result = await sendMediaGeneric({
        cfg,
        to,
        mediaUrl,
        mediaType: contentType,
        caption: text,
      });
      return { channel: "generic-channel", ...result };
    }

    // 降级方案：当不支持媒体类型或没有媒体URL时，将媒体URL作为文本发送
    // 构建完整的文本内容，包含说明文字和媒体附件
    let fullText = text ?? "";
    if (mediaUrl) {
      // 如果已有说明文字，添加换行和媒体链接；否则只添加媒体链接
      fullText = fullText ? `${fullText}\n\n📎 ${mediaUrl}` : `📎 ${mediaUrl}`;
    }

    // 发送纯文本消息（包含媒体URL）
    const result = await sendMessageGeneric({ cfg, to, text: fullText });
    return { channel: "generic-channel", ...result };
  },
};
