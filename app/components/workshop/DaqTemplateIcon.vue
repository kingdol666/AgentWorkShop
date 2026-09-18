<script setup lang="ts">
/**
 * 数采/智控模板图标 —— 全项目唯一的 SVG 片段注入口。
 *
 * 为什么这里必须用 v-html:DAQ_ICONS 的值是 SVG **绘制片段**(path/circle/rect),
 * 必须按 SVG 命名空间解析成图元,文本插值只会把它们画成字面文本。
 * 为什么是安全的:DAO_ICONS 是编译期静态字面量表 —— 键来自 #shared 协议的图标枚举,
 * 值全部是本文件里手写的字符串,不含用户输入、不含 <script>/on* 事件属性/外部引用。
 * 收敛收益:TownView 原先有 6 处 v-html(各自重复同样的判断),现在只此一处。
 */
const props = defineProps<{ icon: string }>()

/** 数采模板图标(设计稿 ICONS;SVG path 直嵌) */
const DAQ_ICONS: Record<string, string> = {
  thermo: '<path d="M10 4a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0V4Z"/><circle cx="12" cy="16.5" r="1.6"/>',
  pressure: '<circle cx="12" cy="12" r="8"/><path d="m12 12 3.5-3.5"/><circle cx="12" cy="12" r="1.2"/>',
  tension: '<circle cx="12" cy="10" r="4"/><path d="M4 18.5h16M8 18.5V14M16 18.5V14"/><path d="M2.5 10H8M16 10h5.5"/>',
  encoder: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 4v3M12 17v3M4 12h3M17 12h3"/>',
  camera: '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="m16 11 5-3v8l-5-3"/><circle cx="8" cy="12" r="2.5"/>',
  gateway: '<rect x="8" y="11" width="8" height="10" rx="1.5"/><circle cx="12" cy="5.5" r="1.5"/><path d="M12 10V7M8.5 8.5a5 5 0 0 1 7 0M6 6a8.5 8.5 0 0 1 12 0"/>',
}

const markup = computed(() => DAQ_ICONS[props.icon] ?? DAQ_ICONS.gateway!)
</script>

<template>
  <!-- eslint-disable vue/no-v-html -- DAQ_ICONS 是编译期静态 SVG 绘制片段(见 script 顶部),不含任何用户输入 -->
  <svg
    viewBox="0 0 24 24"
    v-html="markup"
  />
  <!-- eslint-enable vue/no-v-html -->
</template>
