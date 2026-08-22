import { TodoTreeNode, TodoTreeProvider } from '../todo/todoTreeProvider';

export function flattenTodoNodes(provider: TodoTreeProvider): TodoTreeNode[] {
  const result: TodoTreeNode[] = [];
  const visit = (node?: TodoTreeNode): void => {
    for (const child of provider.getChildren(node)) {
      result.push(child);
      visit(child);
    }
  };
  visit();
  return result;
}
