# 项目管家手工测试夹具

该目录只用于验证插件功能，不包含正式源码。

## 单文件夹验证

在扩展开发宿主中打开：

```text
test-fixtures/workspace-one
```

建议依次屏蔽：

- `normal.txt`：验证单文件规则。
- `generated`：验证目录递归规则。
- `src/app.ts` 和 `中文 空格目录/说明 文件.txt`：验证多选、中文和空格路径。

## 多根工作区验证

在扩展开发宿主中打开：

```text
test-fixtures/multi-root.code-workspace
```

分别选择：

- `工作区一/generated`
- `工作区二/build`

执行屏蔽后，规则应分别写入两个工作区文件夹作用域。

## 工作区外文件验证

打开单文件夹或多根工作区后，再使用“文件 → 打开文件”打开：

```text
test-fixtures/external/outside.txt
```

该文件不属于测试工作区，应显示标签装饰和状态栏提醒。

## 注意

- 屏蔽只修改测试工作区设置，不会删除测试文件。
- 当前版本没有图形化恢复入口。需要重新显示资源时，在测试工作区设置中将对应排除规则改为 `false`。
- 不要把 `test-fixtures` 根目录整体作为测试工作区，否则 `external/outside.txt` 会被视为工作区内文件。
