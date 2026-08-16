export function createCatalogTemplateText(): string {
  return `{
  // schemaVersion（必填）：当前格式版本为 3。旧版 v1、v2 仍可兼容读取。
  "schemaVersion": 3,

  // name（可选）：集合名称，会与真实文件名一起显示在项目集合视图中。
  "name": "我的项目集合",

  // features（可选）：复制本集合文件后，另一位用户会获得相同的功能默认值。
  "features": {
    // tabs：标签页整理功能。
    "tabs": {
      // 是否自动将工作区外和非项目标签移到末尾；项目内标签顺序不变。
      "autoOrganize": false
    },

    // symbolOutline：函数大纲模式。集合内项目使用这里的共享值；工作区显式覆盖优先。
    "symbolOutline": {
      // native：仅原生大纲；enhanced：仅增强大纲；both：同时使用。
      "mode": "both"
    }
  },

  // projects（必填）：推荐使用项目集合视图中的“添加项目”按钮自动添加。
  // 所有 path 都相对于本文件所在目录，并统一使用 / 分隔，不能填写绝对路径。
  "projects": [
    // alias（必填）：项目别名，同一集合内不能重复。
    // path（必填）：例如 "./admin-web" 或 "./server/server.code-workspace"。
    // type（可选）：auto、folder 或 workspace，默认 auto。
    // description（可选）：项目用途说明。
    // tags（可选）：字符串数组，例如 ["前端", "日常开发"]。
  ]
}
`;
}
