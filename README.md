# 360GS Prototype v0.3b

360°写真、360°動画、3D Gaussian Splattingを、専門的な設定なしでブラウザ上から扱うためのプロトタイプです。

## 基本方針

利用者の操作は原則として「ファイルを選ぶ → 自動処理 → 見る」です。解析間隔、RANSAC、SfM、特徴点追跡、Bundle Adjustment、COLMAP、Brushなどの技術設定を利用者が行う必要はありません。

選択した写真、動画、3DGSファイル、学習画像、学習中間データは、現段階ではサーバーへアップロードせず端末内のブラウザで処理します。

## この版でできること

### 360°写真

- JPEG / PNG / WebPの360°写真を選ぶだけで表示
- 2:1の360°画像らしいかを自動確認
- ブラウザ内で自由に見回す

### 3DGS Viewer

- `.ply`、`.compressed.ply`、`.sog` を選ぶだけで表示
- ドラッグで回転、ホイールで拡大縮小
- PlayCanvas Engineでブラウザ表示

### 360°動画 → 3DGS

1. Insta360 Studioなどから書き出した2:1 MP4等を読み込み
2. 縦横比、解像度、長さを自動確認
3. 動画時間に応じて解析量を自動調整
4. 連続性、局所特徴点、対応点を確認
5. RANSAC + Essential matrixで相対姿勢を推定
6. 不安定区間を自動分割
7. 3D化候補だけ局所SfMを再計算
8. 観測不足時は高密度特徴点を自動再探索
9. 安全化した軽量Bundle Adjustmentでカメラ姿勢と疎3D点を調整
10. 良好区間を前・右・後・左の透視学習画像へ変換
11. 黒画像・低情報画像を自動検査
12. Brush / WebGPUでブラウザ内3DGS学習
13. 学習結果をGaussian PLYとして保存
14. 生成結果をその画面で3D表示

処理が次の工程へ進むたびに自動スクロールします。右下の「自動スクロール ON / OFF」で切り替えられます。

## v0.3b Brush / WebGPU学習

画像品質検査を通過し、全体最適化が良好な最初の候補区間を自動学習します。

- BrushのJavaScript / WebAssembly APIを使用
- WebGPU対応GPUで学習
- 学習用データはOrigin Private File Systemの一時領域へ自動配置
- 利用者によるフォルダ選択は不要
- Chrome / Edgeを主対象
- 端末性能から学習回数、最大Gaussian数、最大画像解像度を自動設定
- 学習進捗、反復数、Gaussian数、経過時間を表示
- 評価が得られる場合はPSNR / SSIMも表示
- 一時停止 / 再開 / 中止に対応
- 学習終了後、GPU上のBrush splat buffersを読み戻してGaussian PLYへ変換
- PLYを保存、またはPlayCanvasでその場で表示

現在の自動学習計画は端末性能に応じて約3,500〜8,000反復です。品質と処理時間のバランスは今後、実動画で調整します。

Brushランタイムは`.github/workflows/build-brush-js.yml`で固定コミットからWebAssemblyへビルドし、`vendor/brush-js/`へ配置します。アプリ実行時に外部の学習サーバーは使いません。

## 3DGS学習データの品質確認

全体最適化で良好と判定された区間について、最大24キーフレームを選び、各フレームを4方向へ透視投影します。

- 640 / 768 / 1024 pxを端末性能に応じて自動選択
- JPEGの輝度分散、ダイナミックレンジ、ファイルサイズを検査
- 最初の前・右・後・左を画面にプレビュー
- 不良画像が多い場合は学習データ保存と自動学習を停止
- 正常ならCOLMAPテキストモデルと`init.ply`をZIP保存可能

### ZIP構成

```text
360gs_segment_X_colmap.zip
├─ images/
├─ sparse/0/
│  ├─ cameras.txt
│  ├─ images.txt
│  └─ points3D.txt
├─ init.ply
├─ dataset.json
└─ README.txt
```

## 動画時間への対応

数十秒から約15分程度までを想定し、動画時間に合わせて内部処理量を自動調整します。長時間動画でも全フレームを保持せず、粗い解析から必要区間だけを細分化します。

- 連続性解析: 最大約36 / 90 / 180フレーム
- 局所特徴点解析: 最大18 / 28 / 40キーフレーム
- 相対姿勢解析: 最大30 / 56 / 90キーフレーム
- 局所SfM: 1候補最大24フレーム、1動画最大72フレーム
- 高密度追跡: 176 / 256 / 320 pxを自動選択
- Brush学習: 良好区間から最大12元フレーム、4方向で最大48学習画像を使用

## 安全化した姿勢・3D復元

- 360° bearing vector
- RANSAC + 8点法 + Essential matrix
- Cheiralityによる姿勢候補選択
- 自動区間分割
- ray triangulation
- 信頼度付き複数視点特徴トラック
- 方向分布評価と自動再探索
- Huberロバスト損失
- MADベースの外れ観測整理
- line searchと全体ロールバックを備えた軽量Bundle Adjustment

全体誤差が悪化する更新は採用しません。これはCeres等の大規模Schur complementベースBundle Adjustmentそのものではなく、ブラウザで動作する小規模候補区間向け実装です。

## プライバシー

選択した360°写真、360°動画、3DGS、代表画像、透視画像、特徴点、カメラ姿勢、疎点群、Brush学習データは端末内で処理します。v0.3bではCloudflareやGitHubへユーザーデータをアップロードしません。

## 現在の制約

- カメラ移動のメートル単位の絶対スケールは未確定
- 大規模なグローバルBundle Adjustmentや完全なループ閉合は未実装
- ブラウザ3DGS学習はWebGPU性能とGPUメモリに依存
- Safari / Firefoxは現段階の主要学習対象外
- 3DGSのオンライン永続保存・限定共有は未実装
- Cloudflare R2保存・認証共有は次段階

## 使い方

1. GitHub Pagesの360GSを開く
2. 「360°動画から3Dを作る」を選択
3. Insta360 Studioなどから書き出した2:1 MP4を選択
4. 以降は自動処理
5. 良好区間では画像品質確認後にBrush学習を自動開始
6. 完了後「3DGS PLYを保存」または「この画面で3D表示」を選択

## 主な技術

- HTML / CSS / JavaScript
- Photo Sphere Viewer / Three.js
- PlayCanvas Engine
- WebGL / WebGPU
- Brush JavaScript / WebAssembly
- Origin Private File System
- COLMAP text model
- adaptive 360° video sampling
- equirectangular → perspective projection
- SfM / triangulation / lightweight Bundle Adjustment
- browser-side Gaussian Splatting PLY export

第三者ライブラリの情報は`THIRD_PARTY_NOTICES.md`を参照してください。


### c22 effective-rank Gaussian shape regularization

v0.3c22 keeps the c21 direct equirectangular camera, spherical geometry, post-triangulation pose refinement, SH1, seed budget and browser training resolution fixed. It adds a conservative effective-rank regularizer based on Hyung et al. (NeurIPS 2024) to suppress rank-1 / needle-like Gaussians while preserving disk-like surface splats. The regularizer starts after 25% of training and ramps to weight 0.02 over the next 25%. The optional smallest-axis thinning term from the paper is intentionally omitted because 360GS already applies a Mip-Splatting 3D scale floor.
