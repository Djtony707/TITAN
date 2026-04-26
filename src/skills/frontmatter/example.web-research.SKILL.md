---
name: web_research
version: "1.0.0"
author: titan
description: Research a topic on the web and summarize findings
tags: [web, research, search]
---

When the user asks for research on a topic:
1. Call web_search with the topic
2. Call web_fetch on the top result
3. Summarize the findings in 3 bullet points
