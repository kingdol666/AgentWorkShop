<script setup lang="ts">
/**
 * AwLogo —— 项目标志。
 *
 * 字形 = 工作台门架的 A:单一实心剪影(顶宽 104、基线 408、底宽 216)+ 三角字怀,
 * 16 px 图标位仍能读出字母。颜色走 currentColor:亮底=墨色、暗底=纸白;
 * 品牌绿只保留给状态与启动动画,不做渐变装饰。
 *
 * 同一 path 是唯一真源:desktop/brand/mark.svg、favicon.svg、启动页与标题栏逐字一致。
 * `size` 是字形高度;宽度按字形的 216:304 比例推出,避免方形画布把 A 缩小。
 */
const props = withDefaults(defineProps<{ size?: number }>(), { size: 32 })

const height = computed(() => props.size)
const width = computed(() => Math.round((props.size * 216) / 304))
</script>

<template>
  <svg
    :width="width"
    :height="height"
    viewBox="148 104 216 304"
    fill="none"
    aria-hidden="true"
  >
    <path
      fill="currentColor"
      fill-rule="evenodd"
      d="M232 104H280L364 408H322L294 320H218L190 408H148ZM256 176 222 272H290Z"
    />
  </svg>
</template>
