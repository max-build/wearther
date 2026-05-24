import { OpenAI } from "openai";


const openai = new OpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
  });
  
  export const callDeepseek = async (message) => {
    try {
      const completion = await openai.chat.completions.create({
        messages: [
          { role: "system", content: "Don't exceed 30 words in your responses. Don't specify the weather conditions. Don't start your response with I recommend, or my recommendation is. Only cover the clothing. Don't specify colours for the clothing." },
          { role: "user", content: message },
        ],
        model: "deepseek-chat",
      });
  

    //   console.log(completion.choices[0].message.content);
      return completion.choices[0].message.content;
    } catch (error) {
      throw new Error("Completion failed: " + error.message);
    }
  };
  