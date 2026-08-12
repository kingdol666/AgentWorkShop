<script setup lang="ts">
import type { NuxtError } from '#app'

defineProps<{ error: NuxtError }>()

const handleClear = () => clearError({ redirect: '/' })
</script>

<template>
  <div class="flex-center min-h-screen bg-gray-50">
    <a-result
      :status="error?.statusCode === 404 ? '404' : 'error'"
      :title="`${error?.statusCode ?? 500}`"
      :sub-title="error?.message"
    >
      <template #extra>
        <a-button
          type="primary"
          @click="handleClear"
        >
          返回首页
        </a-button>
      </template>
    </a-result>
  </div>
</template>
