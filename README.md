# ytb-dl-ui

基于 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 的本机桌面视频下载工具。Electron 内嵌页面，不监听 Web 端口。支持 YouTube、抖音、TikTok，平台实际可用性取决于 yt-dlp、登录权限与网络。

## 功能

- 浅色现代化界面：白色卡片、蓝色操作按钮、分状态任务标签和响应式布局。
- 单视频、批量分享链接、播放列表增量解析/跨页选择。
- 原始视频、兼容 MP4 / H.264、画质上限和 MP3 音频。
- 默认同时下载 3 个任务，可调整为 1–5；取消、重试、重启恢复。
- Chrome Cookie 导出教程、授权读取浏览器 Cookie、监测导出的 cookies.txt 变化。
- 下载目录与 HTTP/HTTPS/SOCKS 代理配置。
- yt-dlp stable 更新检查、用户确认后空闲安装、官方签名/SHA256 校验和回滚。

## 使用独立程序

目标产物为 macOS ARM64 / Intel 的 `.app`（ZIP 分发），Windows x64 / ARM64 的单文件 portable `.exe`。程序捆绑 Chromium、yt-dlp（包含 Python/EJS）、Node.js、FFmpeg 和 ffprobe；用户无需安装开发依赖。

1. 解压 macOS ZIP 后打开 `.app`，或双击 Windows `.exe`。自用版本不做付费签名/公证；只对你信任的构建按系统指引放行，不全局关闭系统安全功能。
2. 粘贴每行一个视频链接或分享文字，选择格式、画质与 Cookie 来源，加入队列。
3. 播放列表使用“解析播放列表”，完成/停止后勾选条目，可跨页选择全部。
4. 设置保存目录、并发和代理。代理由你自行提供；程序不会让不可达的站点自动变得可达。
5. 完成后打开文件或所在目录。删除记录不删除下载文件。

Windows portable 会临时解压依赖再启动，首次打开可能较慢。数据保存在系统用户应用目录，不写回 EXE/.app；移动程序不丢失同一用户的历史，不是无痕便携模式。捆绑依赖使程序体积较大。

应用名称为 `ytb-dl-ui`，macOS 包内程序为 `ytb-dl-ui.app`，分发文件使用 `ytb-dl-ui-版本-平台-架构` 前缀。内部 npm 名称与应用标识保持不变，兼容原版本的数据目录和系统安全存储；已有下载目录设置也不会因更名被覆盖。

系统目标为 macOS 13+、Windows 10 22H2+/Windows 11。每种架构仍须在目标系统实测；配置了构建流水线不等于所有平台已完成验收。

## Cookie 与 Chrome

Cookie 是登录凭据，不要发给别人、上传网站或提交到 Git。程序仅将需要的站点 Cookie 存于本机私密目录，不向更新服务发送 Cookie，不写入日志。文件副本不是加密存储；代理凭据使用 Electron 系统安全存储。

### 导出文件

在设置中展开“如何从 Chrome 导出 Cookie？”：

1. 在 Chrome 登录目标站点。
2. 自行选择可信的本地 Cookie 导出扩展，核对来源、权限和隐私政策。程序不安装扩展、不推荐来历不明的扩展。
3. 导出当前站点为 **Netscape cookies.txt**，不使用 JSON。
4. 在程序中导入文件。如授权监测，重新导出到同一个路径后会自动加载。监测文件**不会让 Chrome 自动导出或刷新登录**。
5. 无效、半写入或被删除的文件会明确报错；旧副本不会被当成同步成功继续使用。重新导入可恢复。

### Chrome 自动同步

检测并选择 Chrome 配置文件（Default / Profile N），通过系统确认框授权。每次下载/解析前调用 yt-dlp 支持的浏览器 Cookie 读取能力；也可点击“立即同步”。读取会过滤为目标平台站点，各任务使用隔离临时文件，结束后清理。

- macOS 可能请求钥匙串访问；Windows Chrome 应用绑定加密、数据库锁定或其他浏览器保护可能阻止读取。程序不会提权或绕过保护，失败会引导手动导入。
- Cookie 过期时请在 Chrome **重新登录**，再同步或重新导出。程序不能代为登录、验证码处理或刷新服务端会话。
- Cookie 来源由你明确选择，不会把文件与 Chrome 数据静默混合。可删除文件/停止监测，或撤销 Chrome 授权。
- 正在运行的任务已取得的快照不随来源变化而改写；撤销后后续任务不能继续读取。

## 恢复与更新

下载任务与设置使用带版本的原子状态文件/备份存储。启动时自动恢复排队/中断任务，主动取消/失败的任务只能显式重试。保留原输出模板与 `.part` 文件，远端支持时续传；直播、过期链接、格式改变、合并/转码中断可能需要重新下载。成功任务须有非空最终文件，不能只根据进度 100% 判定。

启动检查 yt-dlp stable 更新不自动安装。确认后等待任务空闲，验证官方签名（固定公钥指纹）与哈希，在用户数据目录安装；保留上一版本供回滚，不改写应用包。离线或失败时明确报错并保留可用版本。完整应用、Node/FFmpeg 通过新的应用包更新。

## 开发与构建

开发者需要 Node.js 22+、npm 和对应系统打包工具；这些不要求终端用户安装。

### 一键构建

仓库根目录提供 [macOS 脚本](build-mac.command) 和 [Windows 脚本](build-windows.cmd)。先安装 Node.js（推荐 22.23.4 或更新版本，包含 npm），首次构建需要联网；脚本不会安装 Node.js 或改变系统安全策略。

- **macOS**：双击 `build-mac.command`，或在终端执行 `./build-mac.command`。
- **Windows**：双击 `build-windows.cmd`，或在 CMD/PowerShell 执行 `.\build-windows.cmd`。窗口会保留构建结果，按任意键关闭。
- 默认构建当前 Node.js 的架构。可传 `x64`、`arm64` 或 `all`；`all` 构建该平台的两种架构：

```sh
# macOS
./build-mac.command all
```

```bat
REM Windows
.\build-windows.cmd all
```

脚本从任意工作目录运行都会定位到仓库根目录，依次执行 `npm ci`、下载/验证内置依赖、类型检查、编译、目标资源校验、平台打包及 SHA256 生成。任一步失败立即停止，不报告构建成功。代理通过 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量传入，不在脚本中写入凭据。

结果位于 `release/`；脚本只构建，不自动发布。指定其他架构时只校验其资源，不冒充原生运行验收。完整测试可单独执行 `npm test` 和 `npm run test:ui`。

### 手动构建

```sh
npm ci
npm run prepare:tools
npm run typecheck
npm test
npm run build
npm run test:ui
npm start
npm run package
npm run checksums
```

`prepare:tools` 下载固定版本资源并验证，首次需要访问 GitHub/Node.js；失败会退出，不能生成伪完整包。资源可以明确指定：

```sh
npm run prepare:tools -- mac arm64
npm run prepare:tools -- mac x64
npm run prepare:tools -- win x64
npm run prepare:tools -- win arm64
```

在匹配平台/架构的机器执行 `npm run package`，输出在 `release/`。macOS 进行 ad-hoc 签名；Windows portable 由 electron-builder 打包。不把系统 Homebrew 动态库当成独立分发资源。

macOS 开发机准备四种资源后可尝试 `npm run package:all` 交叉打包四份程序；交叉打包只验证文件完整性，不代替 Windows/Intel 干净机器的运行验收。自用 ad-hoc 签名包含 JIT 和 library-validation 兼容权限；公开分发应另行设计正式签名/公证。

可通过 `npm run smoke:package -- "/绝对路径/ytb-dl-ui.app/Contents/MacOS/ytb-dl-ui"` 检查打包后的应用启动。该检查使用隔离临时数据目录、禁用更新检查，不读取真实 Chrome Cookie；Windows 单文件程序仍应在 Windows 机器双击验证，不能把 macOS 的启动测试当作 Windows 验收。

需要隔离应用数据时，可用 `--user-data-dir=/已有目录的绝对路径` 启动；默认仍使用系统用户应用目录。

[构建流水线](.github/workflows/build.yml) 包含 macOS 两种架构、Windows x64；Windows ARM64 手动启用并需要标签为 `self-hosted, Windows, ARM64` 的原生 runner。托管 runner 可用性需以仓库 Actions 环境为准。CI 不自动发布 release；正式交付必须获取各平台产物并在干净机器与真实站点验证。

## 第三方依赖与许可

- yt-dlp 固定初始版本 `2026.10.26`，官方独立发行包含 GPLv3+ 依赖，不能把整个二进制误标为仅 Unlicense。来源、构建与完整许可见 [上游](https://github.com/yt-dlp/yt-dlp/tree/2026.10.26) 和包内 `yt-dlp-THIRD_PARTY_LICENSES.txt.txt`。
- macOS/Windows x64 FFmpeg/ffprobe 来自 [ffmpeg-static b6.1.1](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1)。固定 SHA256；完整许可及对应源代码/构建说明随程序封装在 `FFmpeg-LICENSE.txt`、`FFmpeg-README.txt`。核对 GPL/LGPL 构建许可，不能默认视为 LGPL。
- Windows ARM64 FFmpeg/ffprobe 来自 [BtbN 固定构建](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-11-01-12-49) 的 LGPL 变体，包含许可与来源说明。
- Node.js `22.23.4` 来自 [官方发行](https://nodejs.org/dist/v22.23.4/)，核验 SHA256，随包附 Node-LICENSE.txt；[源代码](https://github.com/nodejs/node/tree/v22.23.4)。
- Electron、OpenPGP.js 和代理库的许可见 npm 依赖及 Electron 自带许可证；资源 manifest.json 记录来源和每个文件的 SHA256。

本项目不绕过 DRM、平台登录权限、付费限制或地区限制。仅下载你有权保存的内容。没有提供真实站点成功记录或某架构运行证据时，不应将这些能力视为已验收。