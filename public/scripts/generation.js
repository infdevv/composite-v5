// Generation-related functions for all engines
import { prompts, routerPrompt } from "./constants.js";
import { proxyFetch } from "./utils.js";

// Generation state
export let genned = "";
export let inThinkingMode = false;
export let hasShownThinking = false;
export let currentGeneration = null;
export let generationStopped = false;

// Reset generation flags
export function resetGenerationState() {
    genned = "";
    inThinkingMode = false;
    hasShownThinking = false;
    currentGeneration = null;
    generationStopped = false;
}


async function router(messages) {
    // get last 5 messages only
    messages = messages.slice(-5);
    let prompt = `${routerPrompt}}
    Messages:
    "${messages.join('\n### NEXT TURN:')}"
    `

    try {
        console.log("Router: Calling Pollinations API for model selection...");

        // Use Pollinations API for routing
        const response = await proxyFetch("https://text.pollinations.ai/openai", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messages: [{ "role": "user", "content": prompt }],
                model: "openai",
                temperature: 0.7,
                max_tokens: 500
            })
        });

        const data = await response.json();
        console.log("Router response:", data);

        let content = data.choices?.[0]?.message?.content?.trim();
        console.log("Router raw content:", content);

        // extract JSON
        if (content.includes("```json")) {
            const startIndex = content.indexOf("```json") + "```json".length;
            const endIndex = content.lastIndexOf("```");
            content = content.substring(startIndex, endIndex);
        }

        // parse JSON
        content = JSON.parse(content);

        const model = content?.model || "google/gemma-2-9b-it";
        const promptName = content?.prompt || "none";
        const temperature = content?.temperature || 0.7;
        const top_p = content?.top_p || 1;
        const max_tokens = content?.max_tokens || 26000;

        console.log("Router extracted model:", model);
        console.log("Router extracted prompt:", promptName);
        console.log("Router extracted temperature:", temperature);
        console.log("Router extracted top_p:", top_p);
        console.log("Router extracted max_tokens:", max_tokens);

        return {
            model,
            prompt: promptName,
            temperature: temperature,
            top_p: top_p,
            max_tokens: max_tokens
        };
    } catch (error) {
        console.error("Router error:", error);
        return {
            model: "google/gemma-2-9b-it",
            prompt: "none",
            temperature: 0.7,
            top_p: 1,
            max_tokens: 26000
        }; // fallback
    }
}

export function handleEmit(chunk) {
    let showreasoning = document.getElementById("show-reasoning").checked;
    if (chunk) {
        genned += chunk;

        if (!showreasoning) {
            if (chunk.includes("<think>")) {
                // Emit any content before the <think> tag
                let beforeThink = chunk.split("<think>")[0];
                if (beforeThink && beforeThink.trim()) {
                    window.socket.emit('message', beforeThink);
                }

                inThinkingMode = true;
                hasShownThinking = false;
                if (!hasShownThinking) {
                    window.socket.emit('message', "Thinking");
                    hasShownThinking = true;
                }
                return;
            }

            if (chunk.includes("</think>")) {
                inThinkingMode = false;
                hasShownThinking = false;
                window.socket.emit('message', ".");

                let afterThink = chunk.split("</think>")[1];
                if (afterThink && afterThink.trim()) {
                    window.socket.emit('message', afterThink);
                }
                return;
            }

            if (inThinkingMode) {
                if (chunk.includes(".") || genned.length % 50 === 0) {
                    window.socket.emit('message', ".");
                }
                return;
            }

            console.log("Emitting chunk to socket:", chunk);

            window.socket.emit('message', chunk);
        } else {

                        console.log("Emitting chunk to socket:", chunk);

            window.socket.emit('message', chunk);
        }
    }
}

// Called when generation finishes
export function onFinish(finalMessage) {
    if (!generationStopped) {
        console.log("Generation finished:", finalMessage);
        window.socket.emit('done');
    }
    currentGeneration = null;
    generationStopped = false;
}

// Stop generation
export function stopGeneration() {
    if (generationStopped) {
        console.log("Generation already stopped, ignoring duplicate stop request");
        return;
    }

    console.log("Stopping generation...");
    generationStopped = true;

    inThinkingMode = false;
    hasShownThinking = false;
    genned = "";

    if (currentGeneration) {
        try {
            if (currentGeneration.abort) {
                currentGeneration.abort();
            } else if (currentGeneration.cancel) {
                currentGeneration.cancel();
            }
        } catch (error) {
            console.log("Error stopping generation:", error);
        }
    }

    currentGeneration = null;
    console.log("Generation stopped");
}

// Preprocess messages before sending to AI
export function preprocessMessages(messages, pollinations = false, yuzu = false, overridePrompt = null) {
    let imagemd = document.getElementById("enable-images-checkbox").checked;
    let prefix = overridePrompt || document.getElementById("prefix-prompt").value;
    let reasoning = document.getElementById("turn-on-reasoning").checked;

    let prefixContent = prompts[prefix] || "";

    if (imagemd) {
        prefixContent += prompts["image"] || "";
    }

    if (reasoning) {
        prefixContent += prompts["reasoning"] || "";
    }

    messages[0]["content"] = prefixContent + messages[0]["content"];

    if (pollinations) {
        messages[0]["content"] += Math.random() * 10000; // prevent pollinations from caching
    }

    if (yuzu) {
        messages[0]["content"] += "This roleplay is in English, ensure that your response is fully in english and coherent.";
    }

    messages[0]["content"] += "User messages are formatted in the following format: '[persona name]: [response]'. Do not treat persona name as a piece of input.";

    return messages;
}


// Custom engine generation
export async function streamingGeneratingCustomEngine(messages, customEngineConfig, settings = {}) {
    if (generationStopped) return;

    messages = preprocessMessages(messages);

    // Verify that Custom Engine is actually selected
    const selectedEngine = document.getElementById("engine")?.value;
    if (selectedEngine !== "Custom Engine") {
        console.error('Custom engine generation called but not selected');
        window.socket.emit('message', 'Error: Custom engine was triggered but is not selected. Please refresh the page.');
        onFinish("");
        return;
    }

    if (!customEngineConfig.endpoint) {
        console.error('Custom engine endpoint not configured');
        console.error('Current config:', customEngineConfig);
        window.socket.emit('message', 'Error: Custom engine endpoint not configured. Please enter your API endpoint URL in the Custom Engine Configuration section and click "Save Configuration".');
        onFinish("");
        return;
    }

    if (!customEngineConfig.model) {
        console.error('Custom engine model not configured');
        console.error('Current config:', customEngineConfig);
        window.socket.emit('message', 'Error: Custom engine model not configured. Please enter your model name in the Custom Engine Configuration section and click "Save Configuration".');
        onFinish("");
        return;
    }

    console.log('Custom engine config being used:', customEngineConfig);

    const controller = new AbortController();
    currentGeneration = controller;

    try {
        let requestBody;
        let headers = {
            'Content-Type': 'application/json',
        };
        let endpoint = customEngineConfig.endpoint; // Use local copy

        // Build request based on engine type
        const wantsNonStream = document.getElementById('non-stream-response') ? document.getElementById('non-stream-response').checked : false;

        if (customEngineConfig.type === 'openai') {
            requestBody = {
                model: customEngineConfig.model || document.getElementById("model").value,
                messages: messages,
                stream: wantsNonStream ? false : true,
                non_stream: wantsNonStream ? true : undefined,
                max_tokens: settings.max_tokens || 26000,
                temperature: settings.temperature !== undefined ? settings.temperature : 0.7,
                top_p: settings.top_p !== undefined ? settings.top_p : 1,
                frequency_penalty: settings.frequency_penalty || 0,
                presence_penalty: settings.presence_penalty || 0
            };

            if (customEngineConfig.apiKey) {
                headers['Authorization'] = `Bearer ${customEngineConfig.apiKey}`;
            }

        } else if (customEngineConfig.type === 'gemini') {
            const geminiContents = [];
            let systemPrompt = '';

            for (const msg of messages) {
                if (msg.role === 'system') {
                    systemPrompt += msg.content + '\n';
                } else if (msg.role === 'user') {
                    const userContent = systemPrompt ? systemPrompt + msg.content : msg.content;
                    geminiContents.push({
                        role: 'user',
                        parts: [{ text: userContent }]
                    });
                    systemPrompt = '';
                } else if (msg.role === 'assistant') {
                    geminiContents.push({
                        role: 'model',
                        parts: [{ text: msg.content }]
                    });
                }
            }

            requestBody = {
                contents: geminiContents,
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_LOW_AND_ABOVE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_LOW_AND_ABOVE" }
                ],
                generationConfig: {
                    temperature: settings.temperature !== undefined ? settings.temperature : 0.7,
                    maxOutputTokens: settings.max_tokens || 26000,
                    topP: settings.top_p !== undefined ? settings.top_p : 1
                }
            };

            // For Gemini, the API key can be in header or query param
            // Standard Google AI Studio uses query parameter format
            if (customEngineConfig.apiKey) {
                if (!endpoint.includes('key=')) {
                    // Append API key as query parameter (standard Google AI Studio format)
                    const separator = endpoint.includes('?') ? '&' : '?';
                    endpoint = endpoint + separator + 'key=' + customEngineConfig.apiKey;
                }
                headers['x-goog-api-key'] = customEngineConfig.apiKey;
                delete headers['Authorization'];
            }

        } else {
            requestBody = {
                model: customEngineConfig.model || document.getElementById("model").value,
                messages: messages,
                stream: wantsNonStream ? false : true,
                non_stream: wantsNonStream ? true : undefined
            };

            if (customEngineConfig.apiKey) {
                headers['Authorization'] = `Bearer ${customEngineConfig.apiKey}`;
            }
        }

        console.log('Custom engine request: ' + endpoint);

        // Make direct request
        const response = await proxyFetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error('Custom engine API error:');
            console.error('  Status:', response.status);
            console.error('  Status Text:', response.statusText);
            console.error('  Endpoint:', endpoint);
            console.error('  Engine Type:', customEngineConfig.type);
            console.error('  Response body:', errorBody);

            let errorMessage = `Custom engine API error (${response.status}): ${response.statusText}`;
            if (errorBody) {
                try {
                    const errorJson = JSON.parse(errorBody);
                    errorMessage += `\n${JSON.stringify(errorJson, null, 2)}`;
                } catch {
                    errorMessage += `\n${errorBody.substring(0, 200)}`;
                }
            }

            window.socket.emit('message', errorMessage);
            onFinish("");
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            if (generationStopped) {
                reader.cancel();
                break;
            }

            const { done, value } = await reader.read();
            if (done) {
                onFinish("");
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (generationStopped) break;

                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') {
                        onFinish("");
                        return;
                    }

                    if (!data) continue;

                    try {
                        const parsed = JSON.parse(data);
                        let content = null;

                        if (customEngineConfig.type === 'gemini') {
                            content = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                        } else {
                            content = parsed.choices?.[0]?.delta?.content;
                        }

                        if (content !== undefined && content !== null) {
                            handleEmit(content);
                            console.log("Custom Engine Sent chunk | Delta data: " + content);
                        }
                    } catch (e) {
                        console.error('Error parsing custom engine chunk:', e, 'Raw data:', data);
                    }
                }
            }
        }

    } catch (error) {
        console.error('Custom engine error:', error);
        window.socket.emit('message', `Error with custom engine: ${error.message}`);
        onFinish("");
    }
}

