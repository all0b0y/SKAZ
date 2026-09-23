<div align="center">

<img src="../../icon/icon.png" alt="SKAZ" width="120" height="120">

# SKAZ

**课堂与会议中的第二双耳朵。**

SKAZ 与你一起聆听，实时转写、即时翻译，<br>
回答关于刚刚内容的问题并自动做笔记——每个回答都以录音本身为依据。

[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-111111?logo=apple&logoColor=white)](#快速开始)
[![Electron](https://img.shields.io/badge/Electron-React%20%2B%20TypeScript-47848F?logo=electron&logoColor=white)](#工作原理)
[![Python](https://img.shields.io/badge/backend-Python%203.11%2B-3776AB?logo=python&logoColor=white)](#工作原理)
[![Status](https://img.shields.io/badge/status-early%20development-orange)](#项目状态)

[English](../../README.md) &nbsp;·&nbsp;
[Русский](README.ru.md) &nbsp;·&nbsp;
[Español](README.es.md) &nbsp;·&nbsp;
[Deutsch](README.de.md) &nbsp;·&nbsp;
**简体中文**

</div>

---

## 为什么需要 SKAZ

上课走神两分钟，老师已经讲到了下一个话题；开会时有人叫到你的名字，你却没听清问题。
把一切录下来事后再看，解决不了*当下*的问题。

SKAZ 正是为这一刻而生。它在你的 Mac 上随对话运行，记录带时间戳、可搜索的发言内容。
你可以随时问 **"我刚才错过了什么？"**，几秒内得到回答，并附有指向原话的链接。

SKAZ 绝不打破的一条原则：**不编造没有说过的内容。** 如果录音中没有答案，它会直接告诉你；
模型根据常识补充的内容，会与发言者实际说过的话明确区分开。

## 功能

**🎙️ 实时转写**
从你选择的麦克风进行流式语音识别。语音按说话人分组为段落（A → B → A），
读起来像一段对话，而不是一堵文字墙。

**🌍 实时翻译**
选择预期的语言，译文会随讲话同步出现在原文旁边，原文随时一键可见。

**💬 针对录音提问**
在会话中或结束后提问：*"我错过了什么？"*、*"X 是怎么定义的？"*、*"预算最后怎么定的？"*。
可在单个会话、一个分组或整个资料库中搜索。回答以脚注标注出处，点击即可跳转到转写原文。

**📝 有据可查的笔记**
根据转写生成结构化笔记。每个要点都关联到其来源语段；当录音继续而笔记落后时，SKAZ 会提示。
在类似 Obsidian 的多标签 Markdown 编辑器中编辑。

**📂 以普通文件保存的资料库**
将会话整理到分组中，并以可读的 Markdown 同步到你指定的文件夹——可配合 Obsidian、git
或访达搜索使用。

**📥 导入录音**
导入已有的音频文件，获得与实时会话相同的转写、问答和笔记。

**🧩 自选模型**
为每项任务单独选择模型：转写、助手、笔记和搜索。支持 Soniox（语音）、OpenRouter、
OpenAI 和 Anthropic。不会悄悄替换：如果模型无法胜任，SKAZ 会明确告诉你。

## 隐私优先

- **不保存音频。** 音频流式发送给语音识别后即被丢弃；SKAZ 保存的是文字，而不是录音。
- **本地优先。** 转写、笔记和对话都保存在你的 Mac 上，文本只会发送给你自己配置的服务商。
- **密钥留在本机。** API 密钥加密保存在应用数据目录中，仅所有者可读。
- **封闭的后端。** Python 后端只监听本地回环地址，每次启动都需要新的随机令牌。
- **语音是数据，不是指令。** 现场听到的内容绝不会被当作给助手的指令。

## 工作原理

```
 麦克风 ──► Electron main ──► Python 后端 ──► 语音识别 (Soniox)
                 │                 │
                 │                 ├──► SQLite + Markdown 资料库
                 ▼                 └──► 语言模型（助手、笔记）
            React 界面
```

| 层 | 技术 | 职责 |
|---|---|---|
| 桌面外壳 | Electron | 窗口、麦克风权限、安全 IPC、后端生命周期 |
| 界面 | React + TypeScript、Zustand、CodeMirror 6 | 录音、转写、助手、笔记、设置 |
| 后端 | Python 3.11+、FastAPI、SQLite | 音频流、识别、资料库、助手、笔记 |

## 快速开始

> SKAZ 仍处于早期开发阶段，目标平台为 **Apple Silicon 上的 macOS**，其他平台尚未测试。

**环境要求：** Node.js 20.19+、Python 3.11+、[uv](https://docs.astral.sh/uv/)，
以及至少一个受支持服务商的 API 密钥。

```bash
# 1. 安装依赖
npm install
uv sync --project backend

# 2. 以开发模式运行
npm run dev
```

首次启动时，打开 **Settings → API keys** 添加密钥，选择你使用的语言，然后点击 **Record**。

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 以热重载方式启动应用 |
| `npm test` | 前端单元测试（Vitest） |
| `npm run typecheck` | TypeScript 类型检查 |
| `uv run --project backend pytest` | 后端测试 |
| `npm run dist:mac` | 构建 `SKAZ.app` 和 DMG 安装包——见 [Packaging](../PACKAGING.md) |

## 项目状态

SKAZ 是一个正在积极开发的可用原型。实时转写、翻译、助手、笔记、会话分组和导入已可在本地使用。
接下来：

- [ ] 签名并公证的正式版本
- [ ] 能逐步阅读整个资料库的助手
- [ ] 手动编辑说话人
- [ ] 长时间会话中对睡眠、退出和断网的可靠处理

在首个正式版本发布前，可能存在不完善之处和不兼容的变更。

## 名称由来

*Skaz*（сказ）是俄语词，指以讲述者本人口吻进行的口头叙事。仓库仍沿用最初的工作名称
`AudioHelper`。
