<div align="center">

<img src="../../icon/icon.png" alt="SKAZ" width="128" height="128">

# SKAZ

**课堂与会议中的第二双耳朵。**

[![Release](https://img.shields.io/github/v/release/all0b0y/SKAZ?include_prereleases&label=release&color=2f7c72)](https://github.com/all0b0y/SKAZ/releases/latest)
![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple_Silicon-111111)
![Alpha](https://img.shields.io/badge/status-alpha-orange)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

[English](../../README.md) · [Русский](README.ru.md) · [Español](README.es.md) · [Deutsch](README.de.md) · **简体中文**

<br>

<img src="../images/skaz-demo.webp" alt="SKAZ 快速浏览：实时转写、带来源的回答、搜索范围、笔记与语音服务商" width="880">

<sub>快速浏览 · 使用预设数据的演示配置 · <a href="../images/skaz-demo.mp4">全高清视频（MP4，34 秒）</a></sub>

</div>

SKAZ 是一款 macOS 桌面应用，可将语音转为易读的文字，帮助你找回错过的内容，
并将提问、笔记与原始转写放在一起。

> **Alpha / 抢先体验。** 可能存在错误和不兼容的变更，包括数据格式变化。
> 请备份重要的导出文件。目前面向 Apple Silicon Mac；Windows、Linux 和 Intel Mac
> 尚未验证。应用界面目前仅提供英语。

## 界面预览

<table>
<tr>
<td width="50%"><img src="../images/transcript.webp" alt="实时转写"><br><b>实时转写</b><br>语音变成按说话人整理的易读文字，旁边是会话聊天。</td>
<td width="50%"><img src="../images/sources.webp" alt="带来源的回答"><br><b>带来源的回答</b><br>点击来源链接即可跳到转写中的对应句子。</td>
</tr>
<tr>
<td width="50%"><img src="../images/scope.webp" alt="搜索范围"><br><b>搜索范围</b><br>可针对单个会话、一个分组或整个资料库提问。</td>
<td width="50%"><img src="../images/notes.webp" alt="可编辑的笔记"><br><b>可编辑的笔记</b><br>分标签页编辑 Markdown 笔记，随时导出。</td>
</tr>
<tr>
<td width="50%"><img src="../images/providers.webp" alt="自选服务商"><br><b>自选服务商</b><br>Soniox、OpenAI，或在本机运行的 Local Whisper。</td>
<td width="50%"><img src="../images/light.webp" alt="浅色与深色"><br><b>浅色与深色</b><br>跟随系统，或自行选择主题。</td>
</tr>
</table>

以上均为运行中应用的截图，而非设计稿。转写、回答和笔记均为专门编写的演示数据，
并非真实的语音识别或 AI 输出；上方的快速浏览由这些截图使用 [Remotion](https://www.remotion.dev) 制作。

## 为什么使用 SKAZ

一时没跟上？直接询问错过了什么，不必翻找整段录音。阅读转写、查看回答的来源，
再将有用的内容整理为笔记。AI 可能出错：来源链接有助于核对，但不保证回答正确。

## 功能

- **实时转写与翻译：** 在 **Settings → Transcription** 中选择语音识别服务——Soniox（云端流式、
  完整说话人区分、翻译）、**Local Whisper**（在本机运行 faster-whisper，断网可用；说话人区分为近似，
  仅可翻译为英语）或 OpenAI。按说话人分组，翻译时仍可查看原文。不会在服务之间静默切换。
- **麦克风与系统音频：** 选择麦克风，也可包含 Mac 播放的声音。
  系统音频采集需要 macOS 14.2+ 及系统授权。
- **基于上下文提问：** 查询单个会话、一个分组或整个资料库，通过时间戳引用返回转写。
- **可编辑笔记：** 生成笔记，在标签页中编辑 Markdown，并导出文件。
- **本地资料库：** 将会话分组，也可将文本同步输出到指定文件夹，供 Obsidian 等工具使用。
- **媒体导入（实验性）：** 支持本地音频、视频及 YouTube 导入流程。
  仅处理你有权使用的材料；可用性及支持格式可能不同。
- **独立选择模型：** 分别配置 Assistant 和 Notes，使用 Codex 账号登录，
  或 OpenAI、Anthropic、OpenRouter 的 API 配置。实时语音由所选转写服务处理，而非文本模型。

## 安装与首次启动

从 [GitHub Releases](https://github.com/all0b0y/SKAZ/releases/latest) 下载最新的 DMG
（Apple Silicon，macOS 13 或更高版本），打开后将 SKAZ 拖入 Applications 并启动。
alpha 构建尚未经过 Apple 公证：首次启动时请按发布说明中的步骤操作
（**Privacy & Security → Open Anyway**）。不要全局关闭 macOS 的安全保护。
如需运行当前代码，请参阅[开发环境设置](../../CONTRIBUTING.md)。

首次启动时：

1. 选择预计会听到的语言。
2. 打开 **Settings → API keys**，填入 Soniox 密钥，同意云端处理并保存——
   或者，为让音频留在本机，在 **Settings → Transcription** 中选择 **Local Whisper** 并下载模型
   （下载前显示大小；无需密钥或云端同意）。
3. 在 **Settings → Transcription** 中选择转写或翻译模式，以及翻译目标语言。
4. 分别配置 **Assistant** 和 **Notes**。使用 Codex 时，先安装官方
   [Codex CLI](https://developers.openai.com/codex/cli/)，再通过 SKAZ 的 Codex 设置登录；
   SKAZ 不会自动安装 CLI。也可配置 API 提供商的密钥和模型。
   服务商的账号资格、限额及收费规则仍然适用。
5. 创建会话，选择音频来源，授予所需的 macOS 权限，点击 **Record**。
   按需暂停或停止，打开 **Notes** 整理转写笔记。

录制他人声音前，请取得必要的同意。Soniox 和文本模型服务有各自的价格，MIT 许可不包含这些服务的用量。

## 隐私与数据

- 转写、笔记和聊天保存在本机。不提供用于回放的永久实时音频存档；
  处理或恢复过程中可能使用临时音频。
- 使用 Soniox 或 OpenAI 时，获得同意后音频会发送给该服务；使用 Local Whisper 时在本机识别，
  不会发送。Assistant 和 Notes 会将上下文发送给
  所选服务。服务商的数据保留与训练政策适用：**本地存储不等于离线处理**。
- API 密钥保存在本地加密文件中，加密密钥存放在旁边。主要保护边界是文件权限，
  无法防御以同一用户身份运行的其他进程。也请保护好导出文件和备份。
- Python 后端仅监听 loopback，每次启动使用新令牌。
  限制及当前漏洞报告渠道状态见 [Security](../../SECURITY.md)。

## 工作原理

```text
麦克风 / 系统音频 / 媒体 → Electron → Python → Soniox | Local Whisper | OpenAI
                              ↓         ↓
                          React UI   本地资料库
                                        ↕
                              Assistant / Notes 服务商
```

| 层级 | 技术 |
|---|---|
| 桌面应用 | Electron |
| 界面 | React、TypeScript、CodeMirror |
| 本地后端 | Python、FastAPI、SQLite |

## 开发与项目状态

[Contributing](../../CONTRIBUTING.md) 介绍环境设置、测试和 PR；
[Packaging](../PACKAGING.md) 介绍安装包构建。版本变更将记录在
[GitHub Releases](https://github.com/all0b0y/SKAZ/releases)，不另设 changelog。
小修复可直接提交 PR；大型改动请先讨论。

当前重点包括发布签名与公证、长会话的可靠恢复，以及更多真实场景验证。
实验性媒体导入和网页搜索不代表已达到生产可用标准；Codex 原生网页搜索目前禁用。

[社区行为规范](../../CODE_OF_CONDUCT.md) · [安全政策](../../SECURITY.md) · [MIT 许可](../../LICENSE)

*Skaz*（сказ）是俄语中指口头叙事的词。项目最初的工作名称为 SKAZ。
Copyright © 2026 all0b0y.
