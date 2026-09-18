const cnTemplate = (voiceList: VoiceConfig[], text: string) => `
我希望你根据以下声音配置和一段文字内容，为文字配音提供优化建议。任务包括：
1. 将文字按场景、角色、旁白分割。
2. 根据角色的性格、对话语气，从声音配置中推荐合适的“Name”。
3. 为每段推荐合理的“rate”（语速）、“volume”（音量）、“pitch”（音调）参数。
4. 请不要遗漏语句以及保证语句的顺序。
5. 返回结果为 JSON 格式。


### 声音配置
${JSON.stringify(voiceList, null, 2)}

### 参数说明
- name: 声音配置中的 Name 字段，区分旁白和角色。
- style: 按当前场景情感选择，仅限：normal(中性)、cheerful(开心)、excited(兴奋)、sad(悲伤)、angry(愤怒)、fearful(恐惧)、whispering(低语)、serious(严肃)、gentle(温柔)、calm(平静)、disgruntled(不满)。旁白与平淡叙述用 normal，不必强加情感；对话与情绪强烈的句子按角色情绪选择。
- styleDegree: style 非 normal 时的情感强度（0.5~2.0），normal 时省略。
- rate: 语速调整，百分比形式，默认 +0%（正常），如 "+50%"（加快 50%），"-20%"（减慢 20%）。紧张/追逐可加快，抒情/回忆可放慢。
- volume: 音量调整，百分比形式，默认 +0%（正常），如 "+20%"（增 20%），"-10%"（减 10%）。
- pitch: 音调调整，默认 +0Hz（正常），如 "+10Hz"（提高 10 赫兹），"-5Hz"（降低 5 赫兹）。

### 最终返回JSON格式
{
  segments: [
    {
      name: 'specific voice',
      charactor: '角色名或narration',
      style: 'normal',
      styleDegree: '',
      rate: '语速',
      volume: '音量',
      pitch: '音调',
      text: '文本段落',
    },
  ],
}

### 待处理内容
${text}
`
const engTemplate = (voiceList: VoiceConfig[], text: string) => `
I hope you can provide optimization suggestions for text dubbing based on the following sound configuration and a paragraph of text content. Tasks include:
1. Divide the text by scene, role, and narration.
2. Recommend a suitable "Name" from the sound configuration based on the character's personality and dialogue tone.
3. Recommend reasonable "rate" (speech speed), "volume" (volume), and "pitch" (pitch) parameters for each paragraph.
4. Please do not omit text and ensure the order of text.
5. The result is returned in JSON format.

### Sound configuration
${JSON.stringify(voiceList, null, 2)}

### Parameter description
- name: Name field in the sound configuration, distinguishing between narration and role.
- style: emotion for the current scene, one of: normal, cheerful, excited, sad, angry, fearful, whispering, serious, gentle, calm, disgruntled. Narration and plain text use normal; dialogue follows the character's emotion.
- styleDegree: emotion intensity 0.5~2.0 when style is not normal; omit for normal.
- rate: Speech speed adjustment, percentage form, default +0% (normal), such as "+50%" (50% faster), "-20%" (20% slower).
- volume: Volume adjustment, percentage form, default +0% (normal), such as "+20%" (increase 20%), "-10%" (decrease 10%).
- pitch: pitch adjustment, default +0Hz (normal), such as "+10Hz" (increase 10 Hz), "-5Hz" (decrease 5 Hz).

### Final Output JSON format
{
  segments: [
    {
      name: 'specific voice',
      charactor: '角色名或narration',
      style: 'normal',
      styleDegree: '',
      rate: '语速',
      volume: '音量',
      pitch: '音调',
      text: '文本段落',
    },
  ],
}


### Content to be processed
${text}
`
export function getPrompt(lang = 'cn', voiceList: VoiceConfig[], text: string) {
  switch (lang) {
    case 'zh':
    case 'cn':
      return cnTemplate(
        voiceList.filter((voice) => voice.Name.startsWith('zh')),
        text
      )
    case 'eng':
      return engTemplate(
        voiceList.filter((voice) => voice.Name.startsWith('en')),
        text
      )
    default:
      throw new Error(`Unsupported language: ${lang}`)
  }
}

// ===== 两阶段配音：角色音色规划 + 按固定映射分段 =====

const cnPlanTemplate = (voiceList: { Name: string; Gender?: string }[], sample: string) => `
【角色音色规划】
请通读下面的小说片段，梳理出其中出现的主要角色，并根据每个角色的性格、性别、年龄、身份，从声音配置中为 TA 挑选一个最适合的音色。要求：
1. 只能使用声音配置中存在的 Name，不得编造。
2. 为每个角色标注 gender（female/male），必须与角色在文中的性别一致。
3. 角色的 gender 必须与所选音色的性别一致：女性角色只能选 Gender 为 Female 的音色，男性角色只能选 Gender 为 Male 的音色。
4. 同一角色只有一个音色；主要角色之间音色不要重复。
5. 必须包含一个名为"旁白"的角色，用于叙述性文字。
6. description 用一句**中文**概括角色性格与身份，必须使用中文，不得使用英文。
7. 返回 JSON 格式。

### 声音配置
${JSON.stringify(voiceList, null, 2)}

### 最终返回JSON格式
{
  "characters": [
    { "character": "角色名", "gender": "female", "voice": "声音配置中的 Name", "description": "性格与身份简述" }
  ]
}

### 小说片段（可能只截取了开头部分，请基于其中出现的角色规划）
${sample}
`
const engPlanTemplate = (voiceList: { Name: string; Gender?: string }[], sample: string) => `
【Character voice planning】
Read the novel excerpt below, identify the main characters, and pick the most suitable voice for each from the sound configuration based on personality, gender, age and role. Requirements:
1. Only use existing Name values from the sound configuration.
2. Tag each character with gender ("female"/"male") matching the character in the text.
3. The character's gender MUST match the voice's gender: female characters only pick voices with Gender=Female; male characters only Gender=Male.
4. One voice per character; main characters should not share voices.
5. Must include a character named "Narrator" for narration text.
6. description: one sentence about the character's personality and role.
7. Return JSON.

### Sound configuration
${JSON.stringify(voiceList, null, 2)}

### Final Output JSON format
{
  "characters": [
    { "character": "character name", "gender": "female", "voice": "Name from sound configuration", "description": "personality summary" }
  ]
}

### Novel excerpt
${sample}
`

const cnCharacterSegmentTemplate = (mappingLines: string, text: string) => `
我希望你把下面的文字按角色拆分成配音段落。整本书已有一份固定的角色-音色映射表（见下），同一角色在全书中音色保持一致，你必须严格使用映射表中该角色对应的 Name，不得更换或编造。
映射表中不存在的次要角色，一律使用"旁白"对应的 Name。请不要遗漏语句并保证顺序。
返回 JSON 格式。

### 角色-音色映射表（character -> Name）
${mappingLines}

### 参数说明
- character: 映射表中的角色名
- style: 按当前场景情感选择，仅限：normal(中性)、cheerful(开心)、excited(兴奋)、sad(悲伤)、angry(愤怒)、fearful(恐惧)、whispering(低语)、serious(严肃)、gentle(温柔)、calm(平静)、disgruntled(不满)。旁白与平淡叙述用 normal，不必强加情感；对话与情绪强烈的句子按角色情绪选择。
- styleDegree: style 非 normal 时的情感强度（0.5~2.0），normal 时省略
- rate/volume/pitch: 按角色当前情绪合理取值（"+0%"、"+0Hz" 等）

### 最终返回JSON格式
{
  "segments": [
    { "character": "角色名", "style": "normal", "styleDegree": "", "rate": "+0%", "volume": "+0%", "pitch": "+0Hz", "text": "文本段落" }
  ]
}

### 待处理内容
${text}
`
const engCharacterSegmentTemplate = (mappingLines: string, text: string) => `
Split the text below into dubbed segments by character. The whole book has a FIXED character-to-voice mapping table (below); a character must keep the same voice across the entire book — strictly use the mapped Name, never invent or swap one.
Minor characters not in the mapping always use the "Narrator" Name. Do not omit text and keep the order.
Return JSON.

### Character-to-voice mapping (character -> Name)
${mappingLines}

### Parameter description
- character: character name from the mapping
- style: emotion for the current scene, one of: normal, cheerful, excited, sad, angry, fearful, whispering, serious, gentle, calm, disgruntled. Narration and plain text use normal; dialogue follows the character's emotion.
- styleDegree: emotion intensity 0.5~2.0 when style is not normal; omit for normal
- rate/volume/pitch: reasonable values for the current emotion ("+0%", "+0Hz", etc.)

### Final Output JSON format
{
  "segments": [
    { "character": "character name", "style": "normal", "styleDegree": "", "rate": "+0%", "volume": "+0%", "pitch": "+0Hz", "text": "text segment" }
  ]
}

### Content to be processed
${text}
`

/** 第一阶段：全书角色音色规划（每本书只执行一次） */
export function getCharacterPlanPrompt(
  lang = 'cn',
  voiceList: { Name: string }[],
  sample: string
) {
  const filtered = voiceList.filter((voice) =>
    voice.Name.startsWith(lang === 'eng' ? 'en' : 'zh')
  )
  return lang === 'eng' ? engPlanTemplate(filtered, sample) : cnPlanTemplate(filtered, sample)
}

/** 第二阶段：按固定角色映射分段（保证跨章节音色一致） */
export function getCharacterSegmentPrompt(lang = 'cn', mappingLines: string, text: string) {
  return lang === 'eng'
    ? engCharacterSegmentTemplate(mappingLines, text)
    : cnCharacterSegmentTemplate(mappingLines, text)
}
