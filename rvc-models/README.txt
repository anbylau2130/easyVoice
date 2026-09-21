RVC v2 音色模型目录（挂载进 rvc-server 容器 /app/models）

放置方式（二选一）：
  1. 每个模型一个子目录（推荐）：rvc-models/<模型名>/<模型名>.pth + <模型名>.index
  2. 扁平放置：rvc-models/<模型名>.pth（无检索特征，相似度略低）

模型来源：
  - 社区模型：HuggingFace 搜索 "rvc"（https://huggingface.co/models?search=rvc）
  - 自训模型：RVC WebUI / Applio 训练，推荐 Ov2Super 底模（小数据效果好）
注意：下载后刷新页面即可在「换声源」下拉框中出现；首次转换会从 hf-mirror
拉取基础模型（约 200MB），请耐心等待。
