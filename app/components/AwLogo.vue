<script setup lang="ts">
/**
 * AwLogo —— 项目标志。
 * 六边形品牌壳(绿→青渐变,与数据宪法主色同源)+ 内衬虚线六边形(数字孪生影子)
 * + 三节点互连三角(数采 · 数控 · 产线 三环互连)。
 * public/favicon.svg 与本组件同源;渐变 id 固定,多实例同屏渲染等价。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 32 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 64 64"
    fill="none"
    aria-hidden="true"
  >
    <defs>
      <linearGradient
        id="aw-logo-gradient"
        x1="0"
        y1="0"
        x2="1"
        y2="1"
      >
        <stop
          offset="0"
          stop-color="#35e0a0"
        />
        <stop
          offset="1"
          stop-color="#41c8f4"
        />
      </linearGradient>
    </defs>
    <path
      d="M32 4 L56 18 V46 L32 60 L8 46 V18 Z"
      stroke="url(#aw-logo-gradient)"
      stroke-width="4"
      stroke-linejoin="round"
    />
    <path
      d="M32 15 L46.7 23.5 V40.5 L32 49 L17.3 40.5 V23.5 Z"
      stroke="#41c8f4"
      stroke-opacity="0.45"
      stroke-width="1.8"
      stroke-dasharray="4 3"
    />
    <path
      d="M32 23 L25 38 M32 23 L39 38 M25 38 L39 38"
      stroke="#35e0a0"
      stroke-width="1.8"
      stroke-opacity="0.75"
    />
    <circle
      cx="32"
      cy="23"
      r="3.4"
      fill="#35e0a0"
    />
    <circle
      cx="25"
      cy="38"
      r="3.4"
      fill="#41c8f4"
    />
    <circle
      cx="39"
      cy="38"
      r="3.4"
      fill="#41c8f4"
    />
  </svg>
</template>
