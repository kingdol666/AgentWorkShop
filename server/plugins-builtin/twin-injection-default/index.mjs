/** System default Hybrid Twin plugin: the injection greybox is loaded through
 * the same external provider contract used by third-party industrial scenes. */
export default {
  name: 'twin-injection-default',
  version: '1.0.0',
  description: '系统自带注塑 Hybrid Twin 灰箱 Provider 与 ScenePack',
  auth: 'none',
  async setup(ctx) {
    const core = await ctx.services.get('twinCore')
    const provider = core.createInjectionProvider()
    const scene = core.defaultInjectionScene('twin-injection-default')
    ctx.twin.registerPhysicsProvider(provider)
    ctx.twin.registerScenePack({
      sceneKind: 'injection',
      sceneSchemaVersion: scene.sceneVersion,
      compile: () => scene,
      constraints: scene.constraints,
      datasetSchema: { controls: scene.controls, states: scene.states, observations: scene.observations },
    })
    ctx.logger.info(`默认注塑 Twin Provider 已注册:${provider.manifest.physicsModelId}@${provider.manifest.version}`)
  },

}
