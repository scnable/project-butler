export const STANDARD_SYMBOL_KIND_NAMES = [
  'File',
  'Module',
  'Namespace',
  'Package',
  'Class',
  'Method',
  'Property',
  'Field',
  'Constructor',
  'Enum',
  'Interface',
  'Function',
  'Variable',
  'Constant',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Key',
  'Null',
  'EnumMember',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter',
] as const;

export const SYNTHETIC_SYMBOL_KIND_NAMES = [
  'PreprocessorRegion',
  'PreprocessorBranch',
  'MacroDefinition',
] as const;

export type StandardSymbolKindName = typeof STANDARD_SYMBOL_KIND_NAMES[number];
export type SyntheticSymbolKindName = typeof SYNTHETIC_SYMBOL_KIND_NAMES[number];
export type KnownSymbolKindName = StandardSymbolKindName | SyntheticSymbolKindName;

const STANDARD_SYMBOL_SEMANTICS = {
  File: 'symbol.file',
  Module: 'symbol.module',
  Namespace: 'symbol.namespace',
  Package: 'symbol.package',
  Class: 'symbol.class',
  Method: 'symbol.method',
  Property: 'symbol.property',
  Field: 'symbol.field',
  Constructor: 'symbol.constructor',
  Enum: 'symbol.enum',
  Interface: 'symbol.interface',
  Function: 'symbol.function',
  Variable: 'symbol.variable',
  Constant: 'symbol.constant',
  String: 'symbol.string',
  Number: 'symbol.number',
  Boolean: 'symbol.boolean',
  Array: 'symbol.array',
  Object: 'symbol.object',
  Key: 'symbol.key',
  Null: 'symbol.null',
  EnumMember: 'symbol.enum-member',
  Struct: 'symbol.struct',
  Event: 'symbol.event',
  Operator: 'symbol.operator',
  TypeParameter: 'symbol.type-parameter',
} as const satisfies Record<StandardSymbolKindName, `symbol.${string}`>;

const SYNTHETIC_SYMBOL_SEMANTICS = {
  PreprocessorRegion: 'symbol.preprocessor-region',
  PreprocessorBranch: 'symbol.preprocessor-branch',
  MacroDefinition: 'symbol.macro-definition',
} as const satisfies Record<SyntheticSymbolKindName, `symbol.${string}`>;

const SYMBOL_KIND_LABELS = {
  File: '文件',
  Module: '模块',
  Namespace: '命名空间',
  Package: '包',
  Class: '类',
  Method: '方法',
  Property: '属性',
  Field: '字段',
  Constructor: '构造函数',
  Enum: '枚举',
  Interface: '接口',
  Function: '函数',
  Variable: '变量',
  Constant: '常量',
  String: '字符串',
  Number: '数字',
  Boolean: '布尔值',
  Array: '数组',
  Object: '对象',
  Key: '键',
  Null: '空值',
  EnumMember: '枚举成员',
  Struct: '结构体',
  Event: '事件',
  Operator: '运算符',
  TypeParameter: '类型参数',
  PreprocessorRegion: '条件编译区域',
  PreprocessorBranch: '条件编译分支',
  MacroDefinition: '宏定义',
} as const satisfies Record<KnownSymbolKindName, string>;

export type SymbolIconSemantic =
  | typeof STANDARD_SYMBOL_SEMANTICS[StandardSymbolKindName]
  | typeof SYNTHETIC_SYMBOL_SEMANTICS[SyntheticSymbolKindName]
  | 'symbol.unknown';

export type ObjectIconSemantic =
  | 'product'
  | 'catalog'
  | 'project'
  | 'workspace'
  | 'config'
  | 'preferences'
  | 'resources'
  | 'external-file'
  | 'context.member'
  | 'context.external'
  | 'context.empty'
  | 'project.unavailable.folder'
  | 'project.unavailable.workspace'
  | 'file';
export type StateIconSemantic =
  | 'state.warning'
  | 'state.edited'
  | 'state.long-function'
  | 'state.disabled';
export type IconSemantic = ObjectIconSemantic | SymbolIconSemantic | StateIconSemantic;

export type IconTheme = 'monochrome' | 'light' | 'dark' | 'highContrast';

export type BaselineIconAssetId =
  | 'product'
  | 'project'
  | 'file'
  | 'symbol-function'
  | 'symbol-method'
  | 'symbol-class'
  | 'symbol-generic'
  | 'catalog'
  | 'workspace'
  | 'config'
  | 'preferences'
  | 'resources'
  | 'external-file'
  | 'context-member'
  | 'context-external'
  | 'project-warning'
  | 'workspace-warning'
  | 'symbol-file'
  | 'symbol-module'
  | 'symbol-namespace'
  | 'symbol-package'
  | 'symbol-property'
  | 'symbol-field'
  | 'symbol-constructor'
  | 'symbol-enum'
  | 'symbol-interface'
  | 'symbol-variable'
  | 'symbol-constant'
  | 'symbol-string'
  | 'symbol-number'
  | 'symbol-boolean'
  | 'symbol-array'
  | 'symbol-object'
  | 'symbol-key'
  | 'symbol-null'
  | 'symbol-enum-member'
  | 'symbol-struct'
  | 'symbol-event'
  | 'symbol-operator'
  | 'symbol-type-parameter'
  | 'symbol-preprocessor-region'
  | 'symbol-preprocessor-branch'
  | 'symbol-macro-definition';

export type StateIconAssetId = 'warning' | 'edited' | 'long-function' | 'disabled';

export interface SymbolIconMetadata {
  readonly kind: KnownSymbolKindName | 'Unknown';
  readonly label: string;
  readonly semantic: SymbolIconSemantic;
  readonly known: boolean;
}

export interface IconResourceDescriptor {
  readonly semantic: IconSemantic;
  readonly assetId: BaselineIconAssetId | StateIconAssetId;
  readonly relativePath: string;
  readonly theme: Exclude<IconTheme, 'highContrast'>;
  readonly usedFallback: boolean;
}

const KNOWN_SYMBOL_SEMANTICS: Readonly<Record<KnownSymbolKindName, SymbolIconSemantic>> = {
  ...STANDARD_SYMBOL_SEMANTICS,
  ...SYNTHETIC_SYMBOL_SEMANTICS,
};

const AVAILABLE_BASELINE_ASSETS: Readonly<Partial<Record<IconSemantic, BaselineIconAssetId>>> = {
  product: 'product',
  catalog: 'catalog',
  project: 'project',
  workspace: 'workspace',
  config: 'config',
  preferences: 'preferences',
  resources: 'resources',
  'external-file': 'external-file',
  'context.member': 'context-member',
  'context.external': 'context-external',
  'context.empty': 'workspace',
  'project.unavailable.folder': 'project-warning',
  'project.unavailable.workspace': 'workspace-warning',
  file: 'file',
  'symbol.file': 'symbol-file',
  'symbol.module': 'symbol-module',
  'symbol.namespace': 'symbol-namespace',
  'symbol.package': 'symbol-package',
  'symbol.function': 'symbol-function',
  'symbol.method': 'symbol-method',
  'symbol.class': 'symbol-class',
  'symbol.property': 'symbol-property',
  'symbol.field': 'symbol-field',
  'symbol.constructor': 'symbol-constructor',
  'symbol.enum': 'symbol-enum',
  'symbol.interface': 'symbol-interface',
  'symbol.variable': 'symbol-variable',
  'symbol.constant': 'symbol-constant',
  'symbol.string': 'symbol-string',
  'symbol.number': 'symbol-number',
  'symbol.boolean': 'symbol-boolean',
  'symbol.array': 'symbol-array',
  'symbol.object': 'symbol-object',
  'symbol.key': 'symbol-key',
  'symbol.null': 'symbol-null',
  'symbol.enum-member': 'symbol-enum-member',
  'symbol.struct': 'symbol-struct',
  'symbol.event': 'symbol-event',
  'symbol.operator': 'symbol-operator',
  'symbol.type-parameter': 'symbol-type-parameter',
  'symbol.preprocessor-region': 'symbol-preprocessor-region',
  'symbol.preprocessor-branch': 'symbol-preprocessor-branch',
  'symbol.macro-definition': 'symbol-macro-definition',
  'symbol.unknown': 'symbol-generic',
};

const STATE_ASSETS: Readonly<Record<StateIconSemantic, StateIconAssetId>> = {
  'state.warning': 'warning',
  'state.edited': 'edited',
  'state.long-function': 'long-function',
  'state.disabled': 'disabled',
};

const KNOWN_SYMBOL_KIND_SET: ReadonlySet<string> = new Set([
  ...STANDARD_SYMBOL_KIND_NAMES,
  ...SYNTHETIC_SYMBOL_KIND_NAMES,
]);

export function isKnownSymbolKindName(kind: string): kind is KnownSymbolKindName {
  return KNOWN_SYMBOL_KIND_SET.has(kind);
}

export function getSymbolIconMetadata(kind: string): SymbolIconMetadata {
  if (!isKnownSymbolKindName(kind)) {
    return {
      kind: 'Unknown',
      label: '未知符号',
      semantic: 'symbol.unknown',
      known: false,
    };
  }

  return {
    kind,
    label: SYMBOL_KIND_LABELS[kind],
    semantic: KNOWN_SYMBOL_SEMANTICS[kind],
    known: true,
  };
}

export function resolveIconResource(
  semantic: IconSemantic,
  requestedTheme: IconTheme,
): IconResourceDescriptor {
  if (isStateSemantic(semantic)) {
    const assetId = STATE_ASSETS[semantic];
    return {
      semantic,
      assetId,
      relativePath: `media/icons/state/${assetId}.svg`,
      theme: 'monochrome',
      usedFallback: false,
    };
  }

  const assetId = AVAILABLE_BASELINE_ASSETS[semantic] ?? 'symbol-generic';
  const theme = requestedTheme === 'highContrast' ? 'monochrome' : requestedTheme;
  const fileName = `${assetId}.svg`;
  return {
    semantic,
    assetId,
    relativePath: theme === 'monochrome'
      ? `media/icons/baseline/${fileName}`
      : `media/icons/baseline/color/${theme}/${fileName}`,
    theme,
    usedFallback: AVAILABLE_BASELINE_ASSETS[semantic] === undefined,
  };
}

function isStateSemantic(semantic: IconSemantic): semantic is StateIconSemantic {
  return semantic.startsWith('state.');
}
