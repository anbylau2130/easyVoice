# EasyVoice 🎙️

## 项目简介 ✨  

**EasyVoice** 是一个开源的文本、小说智能转语音解决方案，旨在帮助用户轻松将文本内容转换为高质量的语音输出。  

- **一键生成语音和字幕**

- **AI 智能推荐配音**

- **完全免费，无时长、无字数限制**

- **支持将 10 万字以上的小说一键转为有声书！**

- **流式传输，多长的文本都能立刻播放**

- **支持自定义多角色配音**

无论你是想听小说、为创作配音，还是打造个性化音频，EasyVoice 都是你的最佳助手！

**你可以轻松的将 EasyVoice 部署到你的云服务器或者本地！**

## 体验一下

[easyvoice.ioplus.tech](https://easyvoice.ioplus.tech)

## 核心功能 🌟

- **文本转语音** 📝 ➡️ 🎵  
  一键将大段文本转为语音，高效又省时。
- **流式传输** 🌊  
  再多的文本，都可以迅速返回音频直接开始试听！
- **多语言支持** 🌍  
  支持中文、英文等多种语言。  
- **字幕支持** 💬  
  自动生成字幕文件，方便视频制作和字幕翻译。  
- **角色配音** 🎭  
  提供多种声音选项，完美适配不同角色。  
- **自定义设置** ⚙️  
  可调整语速、音调等参数，打造专属语音风格。  
- **AI 推荐** 🧠  
  通过 AI 智能推荐最适合的语音配置，省心又贴心。  
- **试听功能** 🎧  
  生成前可试听效果，确保每一句都如你所愿！  

## Screenshots📸

![Home](./images/readme.home.jpg)
![Generate](./images/readme.generate.jpg)

## 快速开始 🚀

### 1. 通过 docker 运行

主服务（Web 界面 + API）是一定要部署的，可选的是配音方案：**OpenVoice 换声**、**RVC 换声**、**OmniVoice 克隆**（选装一个或多个）。

#### 方式 A：一键部署（主服务 + OpenVoice + RVC，推荐）

克隆仓库后，Windows 双击 **`deploy.bat`**，Linux/macOS 执行 **`bash deploy.sh`**，或手动执行：

```bash
docker compose --profile vc --profile rvc up -d --build
```

启动 3 个服务：

| 服务 | 端口 | 作用 |
| --- | --- | --- |
| easyvoice | 3000 | 主服务（Web 界面 + API，必部署） |
| vc-server | 9090 | OpenVoice 换声（参考音频零样本换音色） |
| rvc-server | 9091 | RVC v2 换声（已训练模型换音色，相似度最高） |

说明：

- 首次构建约 10-20 分钟（rvc-server 需源码编译），之后启动很快
- RVC 模型不随仓库分发（51 个 .pth 约 3GB，曾致仓库无法 clone）：自行下载放入 `rvc-models/`（`<模型名>/<模型名>.pth` + 可选同名 `.index`），来源见 `rvc-models/README.txt`
- 持久化数据统一映射在 `docker-data/` 目录（生成的音频、模型权重、服务配置），备份迁移直接拷贝即可；若之前用过命名卷版本，老数据不会自动迁移，可手动拷贝或让服务重新下载
- AI 智能配音需要 LLM：部署前编辑 `.env`（可从 `.env.example` 复制）填写 `OPENAI_API_KEY`，或部署后在页面「AI 模型配置」卡片填写
- 极简单容器运行（无换声服务，仅 Edge 预设配音）：

```bash
docker run -d -p 3000:3000 -v $(pwd)/audio:/app/audio cosincox/easyvoice:latest
```

#### 方式 B：只装一种配音方案（OpenVoice 版 / RVC 版 / OmniVoice 版）

```bash
# OpenVoice 版（主服务 + vc-server）
docker compose --profile vc up -d --build

# RVC 版（主服务 + rvc-server）
docker compose --profile rvc up -d --build

# OmniVoice 版（主服务 + omnivoice-server，零样本克隆质量最高）
docker compose --profile omnivoice up -d --build
```

创建有声书时选择对应引擎（「OpenVoice 换声」/「RVC 换声」/「OmniVoice 克隆」）即可使用。

> OmniVoice 说明：新一代零样本克隆 TTS（k2-fsa，Apache-2.0，600+ 语言）。文本 + 参考音频一步合成，克隆相似度高；绑定了换声源的角色直接克隆合成，未绑定的（如旁白）回落 Edge 预设音色。模型已预置进镜像（首次构建约 20-40 分钟、镜像约 8GB，含 CUDA 运行库 CPU/GPU 通用，运行期零下载）；**CPU 可跑但较慢**（约 0.8B 扩散模型，每句数秒到数十秒），推荐 GPU 机器启用。参考音色与 OpenVoice 共用 `voices/` 目录（换声源跨引擎通用）。

**音色设计（Voice Design）**：启用 omnivoice 后访问「有声书」页 → 「🎨 Omni 音色设计」，用文字描述（性别/年龄段/音调/耳语/方言，支持中文）创造声音并随机试听；保存时生成固定声纹样本（`voices/omni-<名字>.wav`）保证全书声音一致。创建有声书选择 OmniVoice 引擎并规划角色时，AI 会依据角色性格与性别自动分配设计音色；角色表「音色」下拉也可手动选用（`omni-` 前缀音色在任何引擎下均可使用）。

#### 方式 C：换声/克隆服务单独部署在另一台机器

主服务照常 `docker compose up -d --build` 部署，换声服务放到其他机器：

```bash
# —— 换声服务所在机器 ——
# OpenVoice（在仓库根目录构建并运行）
docker build -t easyvoice-vc-server ./vc-server
docker run -d -p 9090:9090 --restart unless-stopped \
  -v $(pwd)/voices:/app/references:ro \
  -v $(pwd)/docker-data/vc-checkpoints:/app/checkpoints_v2 \
  easyvoice-vc-server

# RVC（在仓库根目录构建并运行；需 g++ 编译 fairseq，首次构建约 10-20 分钟）
docker build -t easyvoice-rvc-server ./rvc-server
docker run -d -p 9091:9091 --restart unless-stopped \
  -v $(pwd)/rvc-models:/app/models \
  -v $(pwd)/docker-data/rvc-hf-cache:/root/.cache/huggingface \
  easyvoice-rvc-server

# OmniVoice（在仓库根目录构建并运行；模型预置进镜像，首次构建约 15-30 分钟）
docker build -t easyvoice-omnivoice-server ./omnivoice-server
docker run -d -p 9092:9092 --restart unless-stopped --memory 6g \
  -v $(pwd)/voices:/app/references:ro \
  -v $(pwd)/docker-data/omnivoice-prompts:/app/prompts \
  easyvoice-omnivoice-server
```

- OpenVoice 参考音色：把 wav 放进 `voices/` 目录（文件名即换声源名），实时生效
- RVC 音色模型：`rvc-models/<模型名>/<模型名>.pth`（+ 可选同名 `.index`），实时生效；来源见 `rvc-models/README.txt`
- OmniVoice 参考音色：同样放 `voices/` 目录（与 OpenVoice 同名同文件，跨引擎通用）
- Windows 手动运行容器时，`-v` 挂载请使用完整路径（如 `-v D:\easyVoice\rvc-models:/app/models`）

```bash
# —— 主服务所在机器 ——
# 在 .env 中把换声服务指向实际地址：
VC_SERVER_URL=http://换声机IP:9090
RVC_SERVER_URL=http://换声机IP:9091
OMNIVOICE_SERVER_URL=http://换声机IP:9092
```

#### 可选：XTTS 声音克隆

直接用参考声音合成（一步到位但 CPU 较慢），需要时加 `--profile clone`：

```bash
docker compose --profile vc --profile rvc --profile clone up -d --build
```

### 2. 本地运行项目（请先确保已安装 Node.js 环境，参考：[安装 Node.js](https://zhuanlan.zhihu.com/p/442215189)）

```bash
# 开启/安装 pnpm
corepack enable
# 或者使用 npm 安装 pnpm
npm install -g pnpm

# 克隆仓库
git clone git@github.com:cosin2077/easyVoice.git
cd easyVoice
# 安装依赖
pnpm i -r

# 开发模式
pnpm dev:root

# 生产模式
pnpm build:root
pnpm start:root
```

### 3. 生成的音频、字幕保存位置

- Docker 部署： 保存在挂载的 `audio` 目录下
- Node.js 运行保存在 `./packages/backend/audio` 目录下

## 高级

### 角色自定义

启动服务后尝试在命令行运行下述命令：

```bash
curl -X POST http://localhost:3000/api/v1/tts/generateJson \
  -H "Content-Type: application/json" \
  -d '{
  "data": [
    {
      "desc": "徐凤年",
      "text": "你敢动他，我会穷尽一生毁掉卢家，说到做到",
      "voice": "zh-CN-YunjianNeural",
      "volume": "40%"
    },
    {
      "desc": "姜泥",
      "text": "徐凤年，你快走，你打不过的",
      "voice": "zh-CN-XiaoyiNeural"
    },
    {
      "desc": "路人甲",
      "text": "他可是堂堂棠溪剑仙，这小子真是遇到强敌了",
      "voice": "zh-CN-XiaoniNeural",
      "volume": "-20%"
    },
    {
      "desc": "路人乙",
      "text": "这小子真是不知死活，竟然敢挑战卢白撷",
      "voice": "zh-TW-HsiaoChenNeural",
      "volume": "-20%"
    },
    {
      "desc": "旁白",
      "text": "面对棠溪剑仙卢白撷的杀意，徐凤年按住剑柄蓄势待发，他将姜泥放在心尖上，话锋一句比一句犀利，威逼利诱的要求卢白撷放姜泥一条生路。卢白撷也是不撞南墙不回头的人，他与西楚有深仇大恨不得不报...",
      "voice": "zh-CN-YunxiNeural",
      "rate": "0%",
      "pitch": "0Hz",
      "volume": "0%"
    },
    {
      "desc": "旁白",
      "text": "卢白撷凝聚剑气，剑光如虹，直指姜泥。剑气快到姜泥的时候，竟然被一颗小石子打破！万千剑气瞬间消散。居然就是刚刚进入山门的青衣男子。卢白撷心中警铃大作，再次凝结千万水剑想要先下手为强，青衣男子竟然一只手就挡下了，随之飓风盘起，竟然有山呼海啸之势，众人分分被逼退。随后的打斗，青衣男子每一步都精准预测了卢白撷的动作，卢白撷心中惊骇不已。",
      "voice": "zh-CN-YunxiNeural",
      "rate": "0%",
      "pitch": "0Hz",
      "volume": "0%"
    },
    {
      "desc": "卢白撷",
      "text": "人心入局，观子无敌，棋局未央，棋子难逃。你是！？ 曹长卿！",
      "voice": "zh-CN-YunyangNeural",
      "rate": "-2%",
      "pitch": "2Hz",
      "volume": "10%"
    }
  ]
}' \
-o output.mp3

```

你将看到output.mp3文件的生成，并立即可以播放。

#### 参数说明

- text: 你需要转语音的文字。
- voice: 你需要用到的声音，参考：[支持的声音列表](./packages/backend/src/llm/prompt/voiceList.json)
- rate: 语速调整，百分比形式，默认 +0%（正常），如 "+50%"（加快 50%），"-20%"（减慢 20%）。
- volume: 音量调整，百分比形式，默认 +0%（正常），如 "+20%"（增 20%），"-10%"（减 10%）。
- pitch: 音调调整，默认 +0Hz（正常），如 "+10Hz"（提高 10 赫兹），"-5Hz"（降低 5 赫兹）。

### 接入其他 TTS 服务

- TODO

## 技术实现 🛠️

- **前端**：Vue 3 + TypeScript + Element Plus 🌐  
- **后端**：Node.js + Express + TypeScript ⚡  
- **语音合成**：Microsoft Azure TTS(更多引擎接入中) + OpenAI(OpenAI 兼容即可) + ffmpeg 🎤  
- **部署**：Node.js + Docker + Docker Compose 🐳  

## 快速开发 🚀

1.克隆仓库

```bash
git clone https://github.com/cosin2077/easyVoice.git
```

2.安装依赖

```bash
pnpm i -r
```

3.启动项目

```bash
pnpm dev
```

4.打开浏览器，访问 `http://localhost:5173/`，开始体验吧！

## 环境变量 ⚙️

| 变量名              | 默认值                         | 描述                          |
|--------------------|-------------------------------|------------------------------|
| `PORT`             | `3000`                        | 服务端口                      |
| `OPENAI_BASE_URL`  | `https://api.openai.com/v1`   | OpenAI 兼容 API 地址          |
| `OPENAI_API_KEY`   | -                             | OpenAI API Key               |
| `MODEL_NAME`       | -                             | 使用的模型名称                 |
| `RATE_LIMIT_WINDOW`| `1`                           | 速率限制窗口大小（分钟）         |
| `RATE_LIMIT`       | `10`                          | 速率限制次数                   |
| `EDGE_API_LIMIT`   | `3`                           | Edge-TTS API 并发数           |
| `TTS_CLONE_URL`    | `http://xtts-server:8020`     | XTTS 声音克隆服务地址          |
| `VC_SERVER_URL`    | `http://vc-server:9090`       | OpenVoice 换声服务地址         |
| `RVC_SERVER_URL`   | `http://rvc-server:9091`      | RVC 换声服务地址               |
| `OMNIVOICE_SERVER_URL` | `http://omnivoice-server:9092` | OmniVoice 克隆合成服务地址 |
| `COMPOSE_PROFILES` | -                             | 一键启动的可选服务（clone,vc,rvc,omnivoice） |

- **配置文件**：可在 `.env` 或 `packages/backend/.env` 中设置，优先级为 `packages/backend/.env > .env`。  
- **Docker 配置**：通过 `-e` 参数传入环境变量，如上文示例。

## FAQ

- **Q: 如何配置 OpenAI 相关信息?**
- A: 在 `.env` 文件中添加 `OPENAI_API_KEY=your_api_key` `OPENAI_BASE_URL=openai_compatible_base_url` `MODEL_NAME=openai_model_name`，你可以用任何 openai compatible 的 API 地址和模型名称，例如 `https://openrouter.ai/api/v1/` 和 `deepseek`。

- **Q: 为什么我的AI配音效果不好？**
- A: AI 推荐配音是通过大模型来决定不同的段落的配音参数，大模型的能力直接影响配音结果，你可以尝试更换不同的大模型，或者是用 Edge-TTS 选择固定的声音配音。

- **Q: 速度太慢？**
- A: AI 推荐配音需要把输入的文本分段、然后让 AI 分析、推荐每一分段的配音参数，最后再生成音频、拼接。速度会比直接用 Edge-TTS慢。你可以更换相应更快的大模型，或者尝试调节 Edge-TTS 的并发参数：EDGE_API_LIMIT为更大的值(10 以下)，注意并发太高可能会有限制。

## Tips

- 当前主要通过 Edge-TTS API 提供免费语音合成。  

- 未来计划支持官方 API、Google TTS、声音克隆等功能。
