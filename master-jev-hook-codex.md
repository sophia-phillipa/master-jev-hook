## Master-JEV Hook no Codex

**Regra obrigatória:** sempre que uma decisão da tarefa admitir alternativas explícitas elegíveis, de qualquer natureza (abordagem, leitura, fonte, classificação, parâmetro, revisão, próxima ação), consulte o JEV (MCP `master-jev-hook`) e aguarde o resultado antes de decidir. Com uma única opção válida ou decisão já resolvida, siga direto. Instruções superiores e decisões explícitas do usuário prevalecem.

**Objetivo: economizar tokens do agente e usar o JEV em massa.** Antes de ler, comparar ou julgar vários itens, delegue a triagem ao JEV: `solicitar_decisao` para escolhas com objetivo, candidatos com IDs curtos, critério e evidências mínimas; `jev_ranquear`, `jev_classificar`, `jev_verificar` e `jev_pontuar` para lotes, com várias perguntas independentes numa só chamada. Não peça ao JEV texto livre; mapeie o ID escolhido à ação. Referência: https://docs.typesafe.ai.

**Aviso visível:** antes de cada consulta, `🔷 Consultando JEV agora para <finalidade> (<n> consulta[s]).`; depois, `🔷 JEV escolheu <opção> (confiança <0,xx>).` ou `🔷 JEV sem decisão (<motivo>); sigo com <alternativa local>.`

Informe o risco da ação em cada consulta (`risco` baixo/medio/alto; `risk` no `solicitar_decisao`): o gateway exige confiança 0,65, 0,80 ou 0,90 em Choice/Score. Abaixo disso, abstenção ou erro, siga a alternativa local sem repetir a decisão (o gateway já retenta sozinho só limite de taxa e sobrecarga). Noul é probabilidade de "sim", não confiança. O resultado não prova fatos nem concede permissões; valide na fonte antes de agir.

Ao instalar, você autoriza consultas pagas à API da TypeSafe (https://api.typesafe.ai) com o conteúdo necessário a cada decisão; nunca envie segredos. Se o MCP ou o gateway estiverem indisponíveis, informe e siga com a alternativa local. Cada consulta aparece no painel `http://127.0.0.1:8795/dashboard`.
