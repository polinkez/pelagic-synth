const surface = {
  wave: 'sine',
  detune: -7,
  transpose: 0
}

const deep = {
  wave: 'square',
  detune: 5,
  transpose: -12
}

const generative = {
  steps: 32,

  // D minor pentatonic keeps the two independently generated voices compatible.
  surfaceScale: ['D4', 'F4', 'G4', 'A4', 'C5', 'D5'],
  deepScale: ['D3', 'F3', 'G3', 'A3', 'C4'],

  surface: {
    chance: 0.60,
    strongBeatChance: 0.92,
    lengths: [1, 1, 2, 2, 3],
    velocities: [0.28, 0.32, 0.36, 0.42, 0.48]
  },

  deep: {
    chance: 0.68,
    lengths: [3, 4, 4, 6],
    velocities: [0.20, 0.23, 0.26, 0.30]
  }
}

const state = {
  ctx: null,
  initialized: false,
  playing: false,
  scheduler: null,
  nextStepTime: 0,
  step: 0,
  noiseBuffer: null,
  nodes: {},
  analyserData: null,
  phrase: null,
  generation: 0
}

const NOTE_OFFSETS = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3,
  E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8,
  Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11
}

function el(id) {
  return document.getElementById(id)
}

function sliderValue(id) {
  return Number(el(id).value)
}

function updateDepthReadout() {
  const depth = sliderValue('deepDepth')
  const meters = depth * 0.5
  const readout = el('depthReadout')
  if (readout) readout.textContent = `${meters.toFixed(1)} m`
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}

function randomChoice(items) {
  return items[Math.floor(Math.random() * items.length)]
}

function chance(probability) {
  return Math.random() < probability
}

function moveIndex(index, min, max, movement = [-1, 0, 0, 1]) {
  return clamp(index + randomChoice(movement), min, max)
}

function velocityFrom(pool) {
  return randomChoice(pool) * (0.92 + Math.random() * 0.16)
}

function generateTide() {
  const phrase = {
    surface: [],
    deep: [],
    drums: {
      kick: [],
      snare: [],
      hat: [],
      texture: []
    }
  }

  // Surface voice:
  // notes are chosen at runtime from one scale and tend to move to nearby notes,
  // so each cycle is new but still feels like one musical idea.
  let surfaceIndex = Math.floor(Math.random() * (generative.surfaceScale.length - 1))

  for (let step = 0; step < generative.steps; step++) {
    const isStrong = step % 8 === 0
    const isEven = step % 2 === 0
    const shouldPlay =
      isStrong
        ? chance(generative.surface.strongBeatChance)
        : isEven && chance(generative.surface.chance)

    if (shouldPlay) {
      surfaceIndex = moveIndex(
        surfaceIndex,
        0,
        generative.surfaceScale.length - 1,
        [-1, 0, 0, 1, chance(0.16) ? 2 : 0]
      )

      phrase.surface.push({
        step,
        note: generative.surfaceScale[surfaceIndex],
        length: randomChoice(generative.surface.lengths),
        velocity: velocityFrom(generative.surface.velocities)
      })
    }
  }

  // Deep voice:
  // a slower layer is regenerated every tide. It favors roots and neighboring tones.
  let deepIndex = Math.floor(Math.random() * generative.deepScale.length)

  for (let step = 0; step < generative.steps; step += 4) {
    const isAnchor = step % 8 === 0
    if (isAnchor || chance(generative.deep.chance)) {
      deepIndex = moveIndex(
        deepIndex,
        0,
        generative.deepScale.length - 1,
        [-1, 0, 0, 0, 1]
      )

      phrase.deep.push({
        step,
        note: generative.deepScale[deepIndex],
        length: randomChoice(generative.deep.lengths),
        velocity: velocityFrom(generative.deep.velocities)
      })
    }
  }

  // Percussion:
  // no fixed beat array — each 32-step tide is built from probability rules.
  for (let step = 0; step < generative.steps; step++) {
    const quarter = step % 4 === 0
    const halfBar = step % 8 === 0

    if (halfBar || (quarter && chance(0.42)) || chance(0.055)) {
      phrase.drums.kick.push(step)
    }

    if ((step % 8 === 4 && chance(0.90)) || chance(0.035)) {
      phrase.drums.snare.push(step)
    }

    if ((step % 2 === 0 && chance(0.82)) || chance(0.10)) {
      phrase.drums.hat.push(step)
    }

    if ((step === 15 || step === 31) ? chance(0.68) : chance(0.025)) {
      phrase.drums.texture.push(step)
    }
  }

  // Ensure the groove always has a clear beginning.
  if (!phrase.drums.kick.includes(0)) phrase.drums.kick.push(0)

  return phrase
}

function generateNextTide() {
  state.phrase = generateTide()
  state.generation += 1

  const readout = el('generationReadout')
  if (readout) {
    readout.textContent = String(state.generation).padStart(2, '0')
  }
}

function noteToMidi(note) {
  const match = /^([A-G](?:#|b)?)(-?\d+)$/.exec(note)
  if (!match) return 60
  const [, name, octave] = match
  return (Number(octave) + 1) * 12 + NOTE_OFFSETS[name]
}

function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

function noteToFrequency(note, transpose = 0, detune = 0) {
  const midi = noteToMidi(note) + transpose
  return midiToFrequency(midi) * Math.pow(2, detune / 1200)
}

function makeNoiseBuffer(ctx, seconds = 2) {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  return buffer
}

function makeImpulse(ctx, seconds = 2.7, decay = 2.8) {
  const length = Math.ceil(ctx.sampleRate * seconds)
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate)

  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel)
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay)
    }
  }

  return impulse
}

function makeDistortionCurve(amount = 0.1) {
  const samples = 44100
  const curve = new Float32Array(samples)
  const k = Math.max(0.01, amount) * 100
  const deg = Math.PI / 180

  for (let i = 0; i < samples; i++) {
    const x = i * 2 / samples - 1
    curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x))
  }

  return curve
}

async function initInstrument() {
  if (state.initialized) {
    if (state.ctx.state === 'suspended') await state.ctx.resume()
    return
  }

  const AudioContext = window.AudioContext || window.webkitAudioContext
  state.ctx = new AudioContext()
  await state.ctx.resume()

  const ctx = state.ctx
  const n = state.nodes

  // Three source channels: Surface / Deep / Percussion
  n.surfaceGain = ctx.createGain()
  n.deepGain = ctx.createGain()
  n.drumGain = ctx.createGain()

  n.surfacePan = ctx.createStereoPanner()
  n.deepPan = ctx.createStereoPanner()
  n.drumPan = ctx.createStereoPanner()

  n.surfaceGain.connect(n.surfacePan)
  n.deepGain.connect(n.deepPan)
  n.drumGain.connect(n.drumPan)

  // Dry path
  n.dryBus = ctx.createGain()
  n.surfacePan.connect(n.dryBus)
  n.deepPan.connect(n.dryBus)
  n.drumPan.connect(n.dryBus)

  // Send path to serial FX chain
  n.fxIn = ctx.createGain()
  n.surfaceSend = ctx.createGain()
  n.deepSend = ctx.createGain()
  n.drumSend = ctx.createGain()

  n.surfacePan.connect(n.surfaceSend)
  n.deepPan.connect(n.deepSend)
  n.drumPan.connect(n.drumSend)
  n.surfaceSend.connect(n.fxIn)
  n.deepSend.connect(n.fxIn)
  n.drumSend.connect(n.fxIn)

  // FX01: chorus = direct signal + modulated short delay
  n.chorusDirect = ctx.createGain()
  n.chorusDelay = ctx.createDelay(0.06)
  n.chorusDelay.delayTime.value = 0.018
  n.chorusWet = ctx.createGain()
  n.chorusOut = ctx.createGain()

  n.fxIn.connect(n.chorusDirect)
  n.fxIn.connect(n.chorusDelay)
  n.chorusDelay.connect(n.chorusWet)
  n.chorusDirect.connect(n.chorusOut)
  n.chorusWet.connect(n.chorusOut)

  n.chorusLfo = ctx.createOscillator()
  n.chorusLfoGain = ctx.createGain()
  n.chorusLfo.frequency.value = 0.28
  n.chorusLfoGain.gain.value = 0.004
  n.chorusLfo.connect(n.chorusLfoGain)
  n.chorusLfoGain.connect(n.chorusDelay.delayTime)
  n.chorusLfo.start()

  // FX02: feedback delay
  n.delay = ctx.createDelay(1.2)
  n.delayFeedback = ctx.createGain()
  n.delayDirect = ctx.createGain()
  n.delayWet = ctx.createGain()
  n.delayOut = ctx.createGain()

  n.chorusOut.connect(n.delayDirect)
  n.chorusOut.connect(n.delay)
  n.delay.connect(n.delayFeedback)
  n.delayFeedback.connect(n.delay)
  n.delay.connect(n.delayWet)
  n.delayDirect.connect(n.delayOut)
  n.delayWet.connect(n.delayOut)

  // FX03: distortion
  n.distortion = ctx.createWaveShaper()
  n.distortion.oversample = '2x'
  n.delayOut.connect(n.distortion)

  // FX04: reverb with dry/wet balance inside effect
  n.reverb = ctx.createConvolver()
  n.reverb.buffer = makeImpulse(ctx)
  n.reverbDirect = ctx.createGain()
  n.reverbWet = ctx.createGain()
  n.reverbOut = ctx.createGain()

  n.distortion.connect(n.reverbDirect)
  n.distortion.connect(n.reverb)
  n.reverb.connect(n.reverbWet)
  n.reverbDirect.connect(n.reverbOut)
  n.reverbWet.connect(n.reverbOut)

  // Output buses
  n.wetBus = ctx.createGain()
  n.master = ctx.createGain()
  n.analyser = ctx.createAnalyser()
  n.analyser.fftSize = 512
  state.analyserData = new Uint8Array(n.analyser.frequencyBinCount)

  n.reverbOut.connect(n.wetBus)
  n.dryBus.connect(n.master)
  n.wetBus.connect(n.master)
  n.master.connect(n.analyser)
  n.analyser.connect(ctx.destination)

  state.noiseBuffer = makeNoiseBuffer(ctx)
  state.initialized = true

  el('sampleRate').textContent = ctx.sampleRate
  el('audioStatusText').textContent = 'audio ready'

  syncAllControls()
  animateVisual()
}

function syncAllControls() {
  updateDepthReadout()
  if (!state.initialized) return

  const n = state.nodes
  const now = state.ctx.currentTime
  const smooth = 0.025

  // Volume and stereo placement
  n.surfaceGain.gain.setTargetAtTime(sliderValue('surfaceVolume') / 100 * 0.72, now, smooth)
  n.deepGain.gain.setTargetAtTime(sliderValue('deepVolume') / 100 * 0.56, now, smooth)
  n.drumGain.gain.setTargetAtTime(0.86, now, smooth)

  n.surfacePan.pan.setTargetAtTime(sliderValue('surfacePan') / 100, now, smooth)
  n.deepPan.pan.setTargetAtTime(sliderValue('deepPan') / 100, now, smooth)
  n.drumPan.pan.setTargetAtTime(0, now, smooth)

  surface.detune = sliderValue('surfaceDetune')
  deep.detune = sliderValue('deepDetune')
  surface.transpose = sliderValue('surfaceFrequency')
  deep.transpose = sliderValue('deepFrequency')

  // Independent sends into the effect chain
  n.surfaceSend.gain.setTargetAtTime(0.52, now, smooth)
  n.deepSend.gain.setTargetAtTime(0.66, now, smooth)
  n.drumSend.gain.setTargetAtTime(0.28, now, smooth)

  // FX01 chorus
  const chorus = sliderValue('chorusAmount') / 100
  n.chorusDirect.gain.setTargetAtTime(1, now, smooth)
  n.chorusWet.gain.setTargetAtTime(chorus * 0.8, now, smooth)
  n.chorusLfoGain.gain.setTargetAtTime(0.0004 + chorus * 0.008, now, smooth)
  n.chorusLfo.frequency.setTargetAtTime(0.12 + chorus * 0.7, now, smooth)

  // FX02 delay
  const delay = sliderValue('delayAmount') / 100
  n.delayDirect.gain.setTargetAtTime(1, now, smooth)
  n.delayWet.gain.setTargetAtTime(delay * 0.72, now, smooth)
  n.delayFeedback.gain.setTargetAtTime(0.06 + delay * 0.48, now, smooth)
  n.delay.delayTime.setTargetAtTime(0.18 + delay * 0.28, now, smooth)

  // FX03 distortion
  const distortion = sliderValue('distortionAmount') / 100
  n.distortion.curve = makeDistortionCurve(distortion * 0.85)

  // FX04 reverb
  const reverb = sliderValue('reverbAmount') / 100
  n.reverbDirect.gain.setTargetAtTime(1 - reverb * 0.45, now, smooth)
  n.reverbWet.gain.setTargetAtTime(reverb * 0.8, now, smooth)

  // Final wet / dry balance
  n.wetBus.gain.setTargetAtTime(sliderValue('wetLevel') / 100 * 0.78, now, smooth)
  n.dryBus.gain.setTargetAtTime(sliderValue('dryLevel') / 100 * 0.9, now, smooth)
  n.master.gain.setTargetAtTime(0.78, now, smooth)
}

function playSynthNote(voiceName, note, when, stepLength, velocity) {
  const ctx = state.ctx
  const voice = voiceName === 'surface' ? surface : deep
  const bus = voiceName === 'surface' ? state.nodes.surfaceGain : state.nodes.deepGain

  const osc = ctx.createOscillator()
  const amp = ctx.createGain()

  osc.type = voice.wave
  osc.frequency.setValueAtTime(noteToFrequency(note, voice.transpose, voice.detune), when)

  const stepSeconds = getStepDuration()
  const noteDuration = Math.max(0.08, stepLength * stepSeconds)
  const releaseControl = voiceName === 'surface'
    ? 0.15 + sliderValue('surfaceCurrent') / 100 * 1.25
    : 0.35 + sliderValue('deepDepth') / 100 * 2.4

  const attack = voiceName === 'surface' ? 0.025 : 0.055
  const peak = Math.max(0.0001, velocity)
  const sustain = voiceName === 'surface' ? 0.34 : 0.42

  amp.gain.setValueAtTime(0.0001, when)
  amp.gain.exponentialRampToValueAtTime(peak, when + attack)
  amp.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * sustain), when + Math.min(noteDuration, attack + 0.12))
  amp.gain.setValueAtTime(Math.max(0.0001, peak * sustain), when + noteDuration)
  amp.gain.exponentialRampToValueAtTime(0.0001, when + noteDuration + releaseControl)

  osc.connect(amp)
  amp.connect(bus)

  osc.start(when)
  osc.stop(when + noteDuration + releaseControl + 0.08)
}

function playKick(when) {
  const ctx = state.ctx
  const osc = ctx.createOscillator()
  const amp = ctx.createGain()
  const level = sliderValue('kickLevel') / 100

  osc.type = 'sine'
  osc.frequency.setValueAtTime(145, when)
  osc.frequency.exponentialRampToValueAtTime(42, when + 0.13)

  amp.gain.setValueAtTime(Math.max(0.0001, level * 0.95), when)
  amp.gain.exponentialRampToValueAtTime(0.0001, when + 0.19)

  osc.connect(amp)
  amp.connect(state.nodes.drumGain)
  osc.start(when)
  osc.stop(when + 0.2)
}

function playSnare(when) {
  const ctx = state.ctx
  const level = sliderValue('snareLevel') / 100

  const noise = ctx.createBufferSource()
  const noiseGain = ctx.createGain()
  const highpass = ctx.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = 900

  noise.buffer = state.noiseBuffer
  noiseGain.gain.setValueAtTime(Math.max(0.0001, level * 0.72), when)
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.13)

  noise.connect(highpass)
  highpass.connect(noiseGain)
  noiseGain.connect(state.nodes.drumGain)

  const body = ctx.createOscillator()
  const bodyGain = ctx.createGain()
  body.type = 'triangle'
  body.frequency.setValueAtTime(185, when)
  bodyGain.gain.setValueAtTime(Math.max(0.0001, level * 0.25), when)
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.08)
  body.connect(bodyGain)
  bodyGain.connect(state.nodes.drumGain)

  noise.start(when)
  body.start(when)
  noise.stop(when + 0.14)
  body.stop(when + 0.09)
}

function playHat(when) {
  const ctx = state.ctx
  const level = sliderValue('hatLevel') / 100
  const noise = ctx.createBufferSource()
  const gain = ctx.createGain()
  const highpass = ctx.createBiquadFilter()

  noise.buffer = state.noiseBuffer
  highpass.type = 'highpass'
  highpass.frequency.value = 5500

  gain.gain.setValueAtTime(Math.max(0.0001, level * 0.42), when)
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.045)

  noise.connect(highpass)
  highpass.connect(gain)
  gain.connect(state.nodes.drumGain)

  noise.start(when)
  noise.stop(when + 0.055)
}

function playTexture(when) {
  const ctx = state.ctx
  const level = sliderValue('textureLevel') / 100
  const noise = ctx.createBufferSource()
  const gain = ctx.createGain()
  const bandpass = ctx.createBiquadFilter()

  noise.buffer = state.noiseBuffer
  bandpass.type = 'bandpass'
  bandpass.frequency.value = 1250
  bandpass.Q.value = 1.2

  gain.gain.setValueAtTime(Math.max(0.0001, level * 0.38), when)
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.22)

  noise.connect(bandpass)
  bandpass.connect(gain)
  gain.connect(state.nodes.drumGain)

  noise.start(when)
  noise.stop(when + 0.24)
}

function getStepDuration() {
  const bpm = 92
  return (60 / bpm) / 4
}

function eventsForStep(sequence, step) {
  return sequence.filter(event => event.step === step)
}

function scheduleStep(step, when) {
  if (!state.phrase) return

  eventsForStep(state.phrase.surface, step).forEach(event => {
    playSynthNote('surface', event.note, when, event.length, event.velocity)
  })

  eventsForStep(state.phrase.deep, step).forEach(event => {
    playSynthNote('deep', event.note, when, event.length, event.velocity)
  })

  if (state.phrase.drums.kick.includes(step)) playKick(when)
  if (state.phrase.drums.snare.includes(step)) playSnare(when)
  if (state.phrase.drums.hat.includes(step)) playHat(when + 0.004)
  if (state.phrase.drums.texture.includes(step)) playTexture(when)
}

function schedulerTick() {
  if (!state.playing || !state.ctx) return

  const lookAhead = 0.1
  const stepDuration = getStepDuration()

  while (state.nextStepTime < state.ctx.currentTime + lookAhead) {
    scheduleStep(state.step, state.nextStepTime)

    state.nextStepTime += stepDuration
    state.step = (state.step + 1) % generative.steps

    // Every full tide receives a fresh melody, bass movement and drum pattern.
    if (state.step === 0) {
      generateNextTide()
    }
  }
}

async function startComposition() {
  try {
    await initInstrument()

    if (state.ctx.state === 'suspended') await state.ctx.resume()
    if (state.playing) return

    state.playing = true
    state.step = 0
    state.generation = 0
    generateNextTide()
    state.nextStepTime = state.ctx.currentTime + 0.06
    state.scheduler = window.setInterval(schedulerTick, 25)
    schedulerTick()

    el('audioStatus').classList.add('active')
    el('audioStatusText').textContent = 'audio active'
  } catch (error) {
    console.error(error)
    el('audioStatusText').textContent = 'audio error'
  }
}

function stopComposition() {
  if (state.scheduler) {
    window.clearInterval(state.scheduler)
    state.scheduler = null
  }

  state.playing = false
  state.step = 0

  el('audioStatus').classList.remove('active')
  el('audioStatusText').textContent = state.initialized ? 'audio ready' : 'audio idle'
}

function setWave(voice, waveType) {
  if (voice === 'surface') surface.wave = waveType
  if (voice === 'deep') deep.wave = waveType
}

function updateKnobVisual(input) {
  const min = Number(input.min)
  const max = Number(input.max)
  const value = Number(input.value)
  const progress = (value - min) / (max - min)
  const angle = -135 + progress * 270
  const line = input.parentElement.querySelector('.knob-line')

  if (line) line.style.transform = `rotate(${angle}deg)`
}

function animateVisual() {
  const visual = el('visual')
  let drift = 0

  const frame = () => {
    drift += 0.014

    let level = 0
    if (state.initialized && state.nodes.analyser) {
      state.nodes.analyser.getByteFrequencyData(state.analyserData)

      let sum = 0
      for (let i = 0; i < state.analyserData.length; i++) sum += state.analyserData[i]
      level = clamp(sum / state.analyserData.length / 255, 0, 1)
    }

    const pulse = Math.min(1.35, level * 1.65)
    const driftX = Math.sin(drift) * (12 + level * 18)
    const driftY = Math.cos(drift * 0.8) * (9 + level * 14)
    const breath = Math.sin(drift * 0.55) * (6 + level * 8)

    visual.style.setProperty('--pulse', pulse.toFixed(3))
    visual.style.setProperty('--drift-x', `${driftX.toFixed(2)}px`)
    visual.style.setProperty('--drift-y', `${driftY.toFixed(2)}px`)
    visual.style.setProperty('--breath', `${breath.toFixed(2)}px`)

    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)
}

document.addEventListener('DOMContentLoaded', () => {
  updateDepthReadout()
  el('playButton').addEventListener('click', startComposition)
  el('stopButton').addEventListener('click', stopComposition)

  document.querySelectorAll('.wave-row').forEach(group => {
    group.addEventListener('click', event => {
      const button = event.target.closest('.wave')
      if (!button) return

      group.querySelectorAll('.wave').forEach(item => item.classList.remove('active'))
      button.classList.add('active')
      setWave(group.dataset.voice, button.dataset.wave)
    })
  })

  document.querySelectorAll('.knob-input').forEach(input => {
    updateKnobVisual(input)
    input.addEventListener('input', () => {
      updateKnobVisual(input)
      syncAllControls()
    })
  })

  document.querySelectorAll('.slider input[type="range"]').forEach(input => {
    input.addEventListener('input', syncAllControls)
  })

  window.addEventListener('keydown', event => {
    if (event.code !== 'Space') return
    if (['INPUT', 'BUTTON'].includes(document.activeElement?.tagName)) return

    event.preventDefault()
    state.playing ? stopComposition() : startComposition()
  })
})
