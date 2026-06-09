# 发布说明

这个项目是纯静态页面，没有后端，也不需要构建流程。

当前目录下这些文件直接就是可发布产物：

- `index.html`
- `styles.css`
- `app.js`
- `favicon.svg`
- `vendor/ffmpeg/`
- `.nojekyll`

## 发布到 GitHub Pages

1. 新建一个 GitHub 仓库
2. 把当前目录文件上传到仓库根目录
   同时要包含 `vendor/ffmpeg/` 目录
3. 进入仓库设置 `Settings`
4. 打开 `Pages`
5. 在 `Build and deployment` 中选择：
   - `Source: Deploy from a branch`
   - `Branch: main`
   - `Folder: / (root)`
6. 保存后等待 GitHub Pages 发布完成

发布后会得到一个公开网址，可直接发给别人使用。

## 发布到 Cloudflare Pages

1. 登录 Cloudflare
2. 进入 `Workers & Pages`
3. 选择 `Create application`
4. 选择 `Pages`
5. 连接你的 Git 仓库
6. 构建配置里使用：
   - `Framework preset: None`
   - `Build command: 留空`
   - `Build output directory: /`
7. 点击部署

部署完成后会自动获得一个可分享网址。

## 分享前建议

- 优先让用户本地上传视频
- 链接导入只对允许跨域访问的直链有效
- 如果用户网络较慢，可提示先点击“预加载 FFmpeg”和“预加载 OCR”
- 如果只是小范围 10 人内使用，GitHub Pages 和 Cloudflare Pages 免费额度通常够用
