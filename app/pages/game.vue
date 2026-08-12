<script setup lang="ts">
/**
 * /game — Tuxemon Town 2D 自由探索 RPG demo
 *
 * Phaser 4 场景在客户端动态加载(SSR 安全);Vue 只负责壳与 HUD。
 * 场景 -> Vue 单向事件流:pos / fps / coins / npcNear / dialog / ready
 */
import type Phaser from 'phaser'
import type { RpgScene } from '~/game/rpg-scene'

definePageMeta({
  title: 'Tuxemon Town · RPG Demo',
})

const hostRef = ref<HTMLDivElement | null>(null)
const sceneRef = shallowRef<RpgScene | null>(null)
const gameRef = shallowRef<Phaser.Game | null>(null)

// ---------- HUD 状态 ----------
const ready = ref(false)
const pos = ref({ x: 0, y: 0, tileX: 0, tileY: 0 })
const fps = ref(0)
const coins = ref(0)
const npcNear = ref<{ id: number, name: string } | null>(null)
const dialog = ref<{ npcId: number, npcName: string, lines: string[] } | null>(null)
const dialogText = ref('')
const lineIndex = ref(0)
const typing = ref(false)
const TOTAL_COINS = 14

const fpsColor = computed(() => (fps.value >= 50 ? 'text-emerald-400' : fps.value >= 30 ? 'text-amber-400' : 'text-red-400'))
const dialogVisible = computed(() => dialog.value !== null)

let typingTimer: ReturnType<typeof setInterval> | null = null
let advanceLocked = false

function startTyping(lines: string[], start = 0) {
  lineIndex.value = start
  dialogText.value = ''
  typing.value = true
  if (typingTimer)
    clearInterval(typingTimer)
  const text = lines[start] ?? ''
  let i = 0
  typingTimer = setInterval(() => {
    i += 1
    dialogText.value = text.slice(0, i)
    if (i >= text.length) {
      typing.value = false
      if (typingTimer) {
        clearInterval(typingTimer)
        typingTimer = null
      }
    }
  }, 28)
}

function stopTyping() {
  if (typingTimer) {
    clearInterval(typingTimer)
    typingTimer = null
  }
}

/** 空格推进:打字中 -> 显全文;末句 -> 关闭;否则下一句 */
function advanceDialog() {
  if (!dialog.value)
    return
  if (advanceLocked)
    return
  if (typing.value) {
    dialogText.value = dialog.value.lines[lineIndex.value] ?? ''
    typing.value = false
    stopTyping()
    advanceLocked = true
    setTimeout(() => {
      advanceLocked = false
    }, 200)
    return
  }
  if (lineIndex.value < dialog.value.lines.length - 1) {
    startTyping(dialog.value.lines, lineIndex.value + 1)
  }
  else {
    closeDialog()
  }
}

function closeDialog() {
  stopTyping()
  dialog.value = null
  sceneRef.value?.closeDialog()
}

async function boot() {
  if (gameRef.value || !hostRef.value)
    return
  const [{ default: Phaser }, { RpgScene }] = await Promise.all([
    import('phaser'),
    import('~/game/rpg-scene'),
  ])

  const scene = new RpgScene('rpg')
  sceneRef.value = scene

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: hostRef.value,
    width: 960,
    height: 540,
    backgroundColor: '#0b1020',
    pixelArt: true,
    antialias: false,
    roundPixels: true,
    powerPreference: 'high-performance',
    physics: {
      default: 'arcade',
      arcade: { gravity: { x: 0, y: 0 }, debug: false },
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene,
  })
  gameRef.value = game

  // ---------- 场景事件 -> HUD ----------
  scene.on('ready', () => {
    ready.value = true
  })
  scene.on('pos', (e) => {
    pos.value = e
  })
  scene.on('fps', (v) => {
    fps.value = v
  })
  scene.on('coins', (v) => {
    coins.value = v
  })
  scene.on('npcNear', (v) => {
    npcNear.value = v
  })
  scene.on('dialog', (e) => {
    if (e) {
      dialog.value = { npcId: e.npcId, npcName: e.npcName, lines: e.lines }
      startTyping(e.lines, 0)
    }
    else {
      advanceDialog()
    }
  })
}

onMounted(() => {
  boot()
})

onBeforeUnmount(() => {
  stopTyping()
  gameRef.value?.destroy(true)
  gameRef.value = null
  sceneRef.value = null
})
</script>

<template>
  <div class="game-shell">
    <div class="game-frame">
      <!-- Phaser 挂载点 -->
      <div
        ref="hostRef"
        class="game-host"
      />

      <!-- ============ HUD 覆盖层 ============ -->
      <div class="hud pointer-events-none absolute inset-0 z-10 select-none">
        <!-- 顶栏 -->
        <div class="absolute top-0 left-0 right-0 flex items-start justify-between p-4">
          <div class="flex items-center gap-2.5 rounded-lg bg-black/45 px-3.5 py-2 backdrop-blur-sm">
            <div class="h-2.5 w-2.5 rounded-sm bg-[var(--color-primary)] shadow-[0_0_10px_var(--color-primary)]" />
            <div>
              <div class="text-sm leading-tight font-bold tracking-wider text-white">
                TUXEMON TOWN
              </div>
              <div class="text-[10px] leading-tight tracking-widest text-white/50 uppercase">
                2D RPG · Free Explore
              </div>
            </div>
          </div>

          <div class="flex items-center gap-2 rounded-lg bg-black/45 px-3.5 py-2 font-mono text-xs backdrop-blur-sm">
            <span class="text-white/50">📍</span>
            <span
              data-hud="pos"
              class="text-white/90"
            >{{ pos.tileX }},{{ pos.tileY }}</span>
            <span class="mx-1 h-3 w-px bg-white/20" />
            <span
              data-hud="fps"
              class="tabular-nums"
              :class="fpsColor"
            >{{ fps }} FPS</span>
          </div>
        </div>

        <!-- 左下:金币 -->
        <div class="absolute bottom-4 left-4 flex items-center gap-2.5 rounded-lg bg-black/45 px-3.5 py-2 backdrop-blur-sm">
          <span class="relative flex h-8 w-8 items-center justify-center rounded-full bg-amber-400/20 text-base">🪙</span>
          <div>
            <div class="text-[10px] tracking-widest text-white/50 uppercase">
              Coins
            </div>
            <div class="font-mono text-lg leading-tight font-bold text-amber-300 tabular-nums">
              <span data-hud="coins">{{ coins }}</span><span class="text-white/40">/{{ TOTAL_COINS }}</span>
            </div>
          </div>
        </div>

        <!-- 右下:操作提示 -->
        <div class="absolute right-4 bottom-4 hidden rounded-lg bg-black/45 px-3.5 py-2.5 text-[11px] leading-relaxed text-white/70 backdrop-blur-sm sm:block">
          <div class="flex items-center gap-1.5">
            <kbd class="kbd">W</kbd><kbd class="kbd">A</kbd><kbd class="kbd">S</kbd><kbd class="kbd">D</kbd>
            <span class="mx-1 text-white/40">/</span>
            <kbd class="kbd">↑←↓→</kbd>
            <span>移动</span>
          </div>
          <div class="mt-1.5 flex items-center gap-1.5">
            <kbd class="kbd">空格</kbd><span>对话</span>
            <span class="mx-1 text-white/40">·</span>
            <kbd class="kbd">R</kbd><span>重置金币</span>
          </div>
        </div>

        <!-- 底部中央:互动提示 -->
        <Transition
          enter-active-class="transition duration-200"
          enter-from-class="translate-y-3 opacity-0"
          leave-active-class="transition duration-150"
          leave-to-class="translate-y-3 opacity-0"
        >
          <div
            v-if="npcNear && !dialogVisible"
            data-hud="npc-near"
            class="absolute bottom-16 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-black/60 px-4 py-2 text-xs text-white/90 shadow-lg backdrop-blur-sm"
          >
            <span class="relative flex h-2 w-2">
              <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span class="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            <kbd class="kbd">空格</kbd>
            <span>与 <b class="text-white">{{ npcNear.name }}</b> 对话</span>
          </div>
        </Transition>

        <!-- 对话框 -->
        <Transition
          enter-active-class="transition duration-200"
          enter-from-class="translate-y-6 opacity-0"
          leave-active-class="transition duration-150"
          leave-to-class="translate-y-6 opacity-0"
        >
          <div
            v-if="dialogVisible"
            data-hud="dialog"
            class="absolute right-0 bottom-0 left-0 p-4"
          >
            <div class="mx-auto max-w-2xl overflow-hidden rounded-xl border border-white/15 bg-black/70 shadow-2xl backdrop-blur-md">
              <div class="flex items-center gap-2 border-b border-white/10 bg-white/5 px-4 py-2">
                <span class="h-2 w-2 rounded-full bg-[var(--color-primary)]" />
                <span class="text-xs font-bold tracking-wider text-white">{{ dialog?.npcName }}</span>
                <span class="text-[10px] text-white/40">{{ lineIndex + 1 }}/{{ dialog?.lines.length }}</span>
                <span class="ml-auto flex items-center gap-1 text-[10px] text-white/40">
                  <kbd class="kbd">空格</kbd> 继续
                </span>
              </div>
              <div class="px-5 py-4 text-sm leading-relaxed text-white/90">
                {{ dialogText }}<span
                  v-if="typing"
                  class="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-white/70 align-middle"
                />
              </div>
              <div class="h-1 w-full bg-white/5">
                <div
                  class="h-full bg-[var(--color-primary)] transition-all duration-300"
                  :style="{ width: `${((lineIndex + (typing ? 0.3 : 1)) / (dialog?.lines.length ?? 1)) * 100}%` }"
                />
              </div>
            </div>
          </div>
        </Transition>

        <!-- 加载遮罩 -->
        <div
          v-if="!ready"
          data-hud="loading"
          class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0b1020]"
        >
          <div class="flex gap-2">
            <span
              v-for="i in 3"
              :key="i"
              class="h-2.5 w-2.5 animate-bounce rounded-full bg-[var(--color-primary)]"
              :style="{ animationDelay: `${i * 0.15}s` }"
            />
          </div>
          <span class="text-xs tracking-[0.3em] text-white/50 uppercase">Loading Town…</span>
        </div>
      </div>
    </div>

    <p class="mt-3 text-center text-xs text-white/40">
      Phaser 4 · Arcade Physics · Tiled Tilemap · 相机跟随 · 碰撞检测 — 素材: Tuxemon (开源) / Kenney
    </p>
  </div>
</template>

<style scoped>
.game-shell {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.game-frame {
  position: relative;
  width: 100%;
  max-width: 1100px;
  aspect-ratio: 16 / 9;
  border-radius: 14px;
  overflow: hidden;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.08),
    0 24px 60px -20px rgba(0, 0, 0, 0.65);
}

.game-host {
  position: absolute;
  inset: 0;
}

.game-host canvas {
  image-rendering: pixelated;
}

.hud {
  font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-bottom-width: 2px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 10px;
  line-height: 16px;
  color: #fff;
}
</style>
