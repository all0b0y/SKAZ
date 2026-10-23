<div align="center">

<img src="../../icon/icon.png" alt="SKAZ" width="128" height="128">

# SKAZ

### 把课堂、会议和文档变成一个可以提问的 wiki

录制或添加来源 · 提问并获得精确引用 · 自动保持更新的 wiki

[![Release](https://img.shields.io/github/v/release/all0b0y/SKAZ?include_prereleases&label=release&color=2c2e31)](https://github.com/all0b0y/SKAZ/releases/latest)
![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple_Silicon-111111)
![Alpha](https://img.shields.io/badge/status-alpha-orange)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

[English](../../README.md) · [Русский](README.ru.md) · [Español](README.es.md) · [Deutsch](README.de.md) · **简体中文**

<br>

<img src="../images/skaz-tour.webp" alt="SKAZ 导览：录下一堂课、带脚注地就内容提问、允许智能体修改、学习由课程生成的卡片" width="880">

<sub>产品导览 · 使用预先编写数据的演示配置 · <a href="../images/skaz-tour.mp4">完整导览，全高清（MP4，80 秒）</a></sub>

<br><br>

[**安装**](#-安装) · [**功能**](#-功能) · [**隐私**](#-隐私与数据) · [**工作原理**](#-工作原理) · [**参与贡献**](../../CONTRIBUTING.md)

</div>

---

SKAZ 是一款 macOS 应用，用来处理你听到和读到的一切。录制一堂课或一次会议，或者添加 PDF、文章、
视频链接或文件。SKAZ 把每个来源保存在你自己的 Markdown 文件夹里，据此构建 wiki，并在回答问题时
附上指向确切时刻或页码的链接。

> [!WARNING]
> **Alpha / 抢先体验。** 可能存在错误和不兼容的变更，包括已存数据的变更。请备份重要的导出内容。
> SKAZ 面向 Apple Silicon 上的 macOS；Windows、Linux 和 Intel Mac 未经验证。目前界面仅提供英文。

## 💡 为什么选择 SKAZ

一堂课、上周的会议、读过的一章书——它们散落在不同地方，彼此毫无关联。SKAZ 把它们放在一起。
每个来源都会在同一个 wiki 中生成笔记和概念页面，因此课堂和教材里的同一个概念会出现在同一页上。
问一句 *“她关于热力学第二定律说了什么？”*，再顺着脚注回到她说出这句话的那一秒。

AI 可能出错。引用能帮你核实答案，但不能保证答案正确。

## 👀 实际效果

<table>
<tr>
<td width="50%"><img src="../images/tour-record.webp" alt="把一堂课录进文件夹"><br><b>录进文件夹</b><br>选好文件夹，按下 Record，转写随讲话实时出现，按说话人和时间排列。</td>
<td width="50%"><img src="../images/tour-ask.webp" alt="带脚注的回答"><br><b>带引用的回答</b><br>每个论断都有脚注。打开它，SKAZ 就会跳到来源中的那段引文。</td>
</tr>
<tr>
<td width="50%"><img src="../images/tour-edit.webp" alt="智能体在修改 wiki 页面前先征求同意"><br><b>智能体先征求同意</b><br>智能体只能通过 SKAZ 修改 wiki，并且你会在修改发生前看到它：Allow 或 Deny。</td>
<td width="50%"><img src="../images/tour-cards.webp" alt="根据一堂课生成的卡片和测验"><br><b>卡片和测验</b><br>让智能体根据一堂课生成卡片或测验。每个答案都有经过核对的引文支撑；卡片按间隔重复回来复习。</td>
</tr>
<tr>
<td width="50%"><img src="../images/tour-web.webp" alt="批准一次网络搜索，并把找到的页面加入资料库"><br><b>网络搜索，须经你同意</b><br>发送前你会看到确切的搜索词。找到的页面一键加入资料库。</td>
<td width="50%"><img src="../images/tour-diagram.webp" alt="回答中的图表，全尺寸打开"><br><b>图表</b><br>回答可以绘制图表，在你的 Mac 上渲染。可全尺寸打开并放大。</td>
</tr>
<tr>
<td width="50%"><img src="../images/tour-wiki.webp" alt="wiki 概念页面及其关联"><br><b>自己写成的 wiki</b><br>来自所有来源的概念页面，彼此关联，并标明哪些是引文、哪些是智能体的推断。</td>
<td width="50%"><img src="../images/tour-theme.webp" alt="切换到深色主题"><br><b>浅色与深色</b><br>跟随系统，或在 <b>Settings → Appearance</b> 中选择主题。</td>
</tr>
</table>

<sub>使用 <a href="https://github.com/heygen-com/hyperframes">HyperFrames</a> 由 SKAZ 0.3.1 自身的界面（其 HTML 和 CSS）制作。
课程、幻灯片、回答、卡片和网络结果均为预先编写的演示数据，并非真实的语音识别、AI 输出或搜索。</sub>

## ✨ 功能

| | |
|---|---|
| 🎙️ **实时录制** | 麦克风，也可同时录制 Mac 的声音（Zoom、视频；需要 macOS 14.2+ 和系统授权）。识别可选 **Soniox**（云端流式、说话人分离、翻译）或 **本机 Whisper**（离线可用）。SKAZ 从不悄悄切换服务。 |
| 📚 **任何来源** | PDF、文档、文本和 Markdown 文件、音频和视频文件、网页文章（已清理）、任意长度的粘贴文本，以及 YouTube、VK Video、RuTube 和 Vimeo 的视频链接。请仅使用你有权处理的资料。 |
| 🧠 **活的 wiki** | 每个来源都有笔记，每个概念在所有文件夹中只有一页，还可以保存分析。每条陈述都有标记：来源引文、智能体推断的关联，或智能体的解释。来源之间有矛盾时，两种说法都会列出，由你决定。 |
| 💬 **带脚注的聊天** | 就整个资料库提问；智能体知道当前打开了什么、是否正在录制。脚注会打开录音中的确切时刻或文档的对应页。用 **@** 指向某个页面、资料或聊天。回答可以包含图表，并可全尺寸查看。 |
| 🃏 **卡片和测验** | 让智能体根据页面、资料或聊天生成卡片或测验。每个正确答案都有经过核对的引文支撑。卡片按 FSRS 间隔重复复习；卡组和测验可以保存到 wiki。 |
| 🌐 **网络搜索，须经你同意** | 在任何内容离开你的 Mac 之前，你会看到确切的搜索词，并选择 Allow once、Allow in this chat 或 Deny。只发送搜索词。找到的页面可一键加入资料库。 |
| 🤖 **你的智能体** | **Codex**、**Claude Code**、**Hermes Agent** 或 **OpenCode**，使用你自己的订阅或密钥；SKAZ 可以替你安装。智能体通过 SKAZ 工具读取资料库，只有在你允许后才会修改 wiki 页面，并可撤销（Undo）；你自己的笔记不会被改动。每个聊天可以单独选择模型，常用模型可加星标收藏。归档之类的小决定可以交给本地模型或 OpenRouter。 |
| ✍️ **识别纠错** | 可选的检查会找出可能的识别错误，修正有把握的部分，只高亮存疑之处。每处修正都可撤销。 |
| 🗂️ **普通文件** | 资料库就是一个 `.md` 文件夹。可以用 **Obsidian** 打开，或把所有内容导出为普通 Markdown，来源以脚注形式保留。你对 wiki 页面的修改受到保护，智能体不会覆盖。 |
| 🔄 **更新** | SKAZ 在启动时和每天一次检查 GitHub 发布，并可在 **Settings → About** 中安装经过校验的更新。 |

## 📦 安装

把下面这行粘贴到终端（Apple Silicon，macOS 13 或更高版本）：

```bash
curl -fsSL https://raw.githubusercontent.com/all0b0y/SKAZ/main/install.sh | bash
```

该[脚本](../../install.sh)会下载最新版本，校验 SHA-256 校验和与 SKAZ 的签名，把 SKAZ 安装到“应用程序”
并打开它。更新时再运行同一条命令即可——资料库和设置都会保留。SKAZ 尚未经过 Apple 公证；通过这种方式
安装的应用打开时不会出现“Apple 无法验证……”的警告。

<details>
<summary><b>改用 DMG 或 PKG 安装</b></summary>
<br>

从 [GitHub Releases](https://github.com/all0b0y/SKAZ/releases/latest) 下载 `SKAZ-<version>-arm64.dmg`
（或 `.pkg` 安装包），打开后把 SKAZ 拖到“应用程序”。首次启动时 macOS 会提示无法验证 SKAZ：请点
**完成**，不要点“移到废纸篓”。然后打开 **系统设置 → 隐私与安全性**，在关于 SKAZ 的提示旁点
**仍要打开**。每个下载的版本只需操作一次。请不要全局关闭 macOS 的安全保护。

</details>

想运行当前代码？请参阅[开发环境设置](../../CONTRIBUTING.md)。

### 🚀 首次启动

1. **智能体。** 选择 Codex、Claude Code、Hermes Agent 或 OpenCode，并用你自己的账号登录。SKAZ 可以替你
   安装智能体。服务商的资格条件、额度和费用均适用。
2. **语音。** 添加 Soniox 密钥并允许向 Soniox 发送音频，或者选择 **Whisper on this computer**
   并下载语音模型（会先显示大小；无需密钥）。
3. **资料库。** 选择资料库存放位置；SKAZ 会建议“文稿”中的一个文件夹。
4. **开始使用。** 按 **Record**（旁边可选择文件夹），或用 **+ Material** 添加文件、链接或文本。
   在聊天中提问；打开 **Wiki** 查看 SKAZ 构建的内容。

所有选择之后都可以在 **Settings** 中更改。

> [!IMPORTANT]
> 录制他人之前请先征得同意。Soniox、各智能体和 OpenRouter 有各自的价格和政策；MIT 许可证不涵盖它们的使用。

## 🔒 隐私与数据

| 内容 | 存放位置 / 去向 |
|---|---|
| 资料和 wiki | 你选择的资料库文件夹中的普通 `.md` 文件。 |
| 索引、聊天、设置 | SKAZ 自己的应用文件夹中的本地文件。 |
| 实时音频 | 不会作为可回放的存档保存。可能会使用临时音频进行处理或恢复。 |
| 语音识别 | **Soniox：** 在你同意后发送音频，你可以随时撤回同意。**本机 Whisper：** 音频不会离开你的 Mac。 |
| 智能体 | 你的问题以及它读取的资料库内容会发送给你选择的智能体；其数据保留和训练政策适用。 |
| 网络搜索 | 只发送你批准的搜索词，交给卡片上注明的智能体的搜索——不含聊天记录和资料库文本。添加找到的页面只会向该地址发送一次请求。 |
| 密钥 | SKAZ 应用文件夹中的加密本地文件，加密密钥就放在旁边。文件权限是主要的边界，无法防护以你的用户身份运行的进程。 |
| 活动日志 | 不包含对话文本和密钥。 |
| 后端 | Python，仅限 loopback，每次启动使用新的令牌。 |

来源中的文本是数据，绝不是指令：面向 AI 的段落会被排除在 wiki 之外，SKAZ 会告诉你，并提供恢复的方式。
**本地存储不等于离线处理。** 也请保护好导出内容和备份。
限制与报告渠道请参阅[安全政策](../../SECURITY.md)。

## 🧩 工作原理

```text
麦克风 / 系统音频 / 文件 / 链接 → Electron → Python ── Soniox | 本机 Whisper
                                   ↓          ↓
                               React UI   资料库：Materials/*.md, Wiki/*.md
                                              ↕  SKAZ 工具（修改须经你同意）
                                   Codex | Claude Code | Hermes Agent | OpenCode
```

| 层 | 技术栈 |
|---|---|
| 桌面 | Electron |
| 界面 | React、TypeScript、CodeMirror |
| 本地后端 | Python、FastAPI，以及基于 Markdown 文件的 SQLite 索引 |

## 🗺️ 下一步

- [ ] 为发布版本进行 Apple 公证
- [ ] 基于 PDF 演示文稿的图文回答和笔记
- [ ] 更广泛的真实场景验证

## 🤝 参与贡献

[Contributing](../../CONTRIBUTING.md) 介绍环境设置、测试和 pull request；[Packaging](../PACKAGING.md)
介绍如何构建安装包。小的修复可以直接提交 PR——较大的改动请先在 issue 中讨论。发布说明见
[GitHub Releases](https://github.com/all0b0y/SKAZ/releases)。

[社区规则](../../CODE_OF_CONDUCT.md) · [安全政策](../../SECURITY.md) · [MIT 许可证](../../LICENSE)

---

<div align="center">
<sub><i>Skaz</i>（сказ）是俄语中“口头叙述”的意思。旧名 AudioHelper。<br>
Copyright © 2026 all0b0y.</sub>
</div>
