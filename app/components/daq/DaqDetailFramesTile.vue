<script setup lang="ts">
/**
 * 帧视图(v2 多形态信号)—— 向量轮廓 + 帧表 / 图像画廊 + 原图查看。
 * 渲染开关(scalar 节点不渲染)在页面;大图查看是纯 UI 态,留在本组件内。
 * VEC_W/VEC_H 与折线点串同源,直接从 useDaqDetailFrames 取常量,避免第二份尺寸口径。
 */
import { ref } from 'vue'
import type { DaqFrameLive } from '@/app/composables/workshop/useDaqStream'
import { VEC_H, VEC_W } from '../../pages/daq/composables/useDaqDetailFrames'

defineProps<{
  signalKind: string
  frames: DaqFrameLive[]
  vecPath: string
}>()

const emit = defineEmits<{ reload: [] }>()

/* 图像大图查看(点击缩略图;contentUrl 同源 cookie 鉴权直出) */
const fullFrame = ref<DaqFrameLive | null>(null)

const timeOf = (at: number): string => new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
const metricsBrief = (f: DaqFrameLive): string =>
  Object.entries(f.metrics ?? {}).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(' ')
</script>

<template>
  <section class="aw-tile pad frames-tile">
    <div class="hist-hd">
      <h3 class="sec">
        {{ signalKind === 'image' ? $t('daqDetail.kfrm0001') : $t('daqDetail.kfrm0002') }}
        <span class="mono frames-n">{{ frames.length }}</span>
      </h3>
      <button
        class="pill-btn"
        @click="emit('reload')"
      >
        {{ $t('daqDetail.k3x1jg022') }}
      </button>
    </div>

    <!-- 向量:最近帧轮廓 + 帧表 -->
    <template v-if="signalKind === 'vector'">
      <svg
        class="vec-svg"
        :viewBox="`0 0 ${VEC_W} ${VEC_H}`"
        preserveAspectRatio="none"
      >
        <polyline
          :points="vecPath"
          fill="none"
          stroke="var(--accent)"
          stroke-width="1.5"
        />
      </svg>
      <table class="raw-table mono">
        <thead>
          <tr><th>{{ $t('daqDetail.k40vsf023') }}</th><th>{{ $t('daqDetail.kfrm0004') }}</th><th>{{ $t('daqDetail.kfrm0005') }}</th></tr>
        </thead>
        <tbody>
          <tr
            v-for="f in frames.filter(x => x.kind === 'vector').slice(0, 12)"
            :key="f.at"
          >
            <td>{{ timeOf(f.at) }}</td>
            <td>{{ f.points?.length ?? 0 }}</td>
            <td>{{ metricsBrief(f) }}</td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 图像:缩略图画gallery(懒加载;点击看原图) -->
    <template v-else>
      <div
        v-if="frames.length"
        class="gal"
      >
        <figure
          v-for="f in frames"
          :key="f.at"
          class="gal-item"
          :title="$t('daqDetail.kfrm0006')"
          @click="fullFrame = f"
        >
          <img
            :src="f.thumbUrl"
            loading="lazy"
            alt="daq frame"
          >
          <figcaption class="mono">
            {{ timeOf(f.at) }} · {{ metricsBrief(f) }}
          </figcaption>
        </figure>
      </div>
      <p
        v-else
        class="frames-empty"
      >
        {{ $t('daqDetail.kfrm0003') }}
      </p>
      <div
        v-if="fullFrame"
        class="gal-full"
        @click="fullFrame = null"
      >
        <img
          :src="fullFrame.contentUrl ?? fullFrame.thumbUrl"
          alt="daq frame full"
        >
      </div>
    </template>
  </section>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.sec/.pad/.input/.hist-hd/.raw-table)在此各持一份逐字相同的副本,
   以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.sec { margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); }
.pad { padding: 16px 18px; }
.hist-hd { display: flex; gap: 10px; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.raw-table { width: 100%; margin-top: 10px; font-size: 11px; border-collapse: collapse; }
.raw-table th, .raw-table td { padding: 4px 6px; text-align: left; border-bottom: 1px solid var(--divider-hair); }
.raw-table th { font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-faint); }

/* 帧视图(v2 多形态) */
.frames-tile { margin-top: 14px; }
.frames-n { margin-left: 8px; color: var(--ink-faint); }
.vec-svg { width: 100%; height: 96px; display: block; background: var(--tone-neutral-bg); border-radius: 6px; margin-bottom: 10px; }
.gal { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.gal-item { margin: 0; cursor: zoom-in; }
.gal-item img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 6px; display: block; background: var(--tone-neutral-bg); }
.gal-item figcaption { margin-top: 4px; font-size: 11px; color: var(--ink-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.frames-empty { margin: 8px 0; font-size: 13px; color: var(--ink-faint); }
.gal-full { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgb(0 0 0 / 72%); cursor: zoom-out; }
.gal-full img { max-width: 92vw; max-height: 92vh; border-radius: 8px; }
</style>
