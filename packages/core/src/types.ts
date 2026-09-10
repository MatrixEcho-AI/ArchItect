/** 方块坐标。+X 东、+Y 上、+Z 南，整数，代表方块最小角。 */
export interface Pos {
  x: number
  y: number
  z: number
}

/** 闭区间工区。 */
export interface Bounds {
  min: Pos
  max: Pos
}

/** 一个方块属性的声明，对应 minecraft-data 的 `block.states[i]`。 */
export interface BlockProperty {
  name: string
  /** 'enum' | 'bool' | 'int'；bool 没有 values。 */
  type: string
  num_values: number
  values?: string[]
}

/** 一个方块类型，对应 minecraft-data 的 `blocksByName[name]`。 */
export interface BlockType {
  id: number
  name: string
  /** 该方块 state id 区间的起点。**注意：这不是默认 state**（见 state.ts）。 */
  minStateId: number
  maxStateId: number
  /** 默认 state 的全局 id。缺省属性必须从这里继承，而不是 values[0]。 */
  defaultState: number
  states: BlockProperty[]
}

export type PropertyValue = string | boolean | number
export type Properties = Record<string, PropertyValue>

/** 规范化后的坐标，用于集合去重。 */
export function posKey(p: Pos): string {
  return `${p.x},${p.y},${p.z}`
}
