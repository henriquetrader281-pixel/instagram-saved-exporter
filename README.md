# Instagram Saved Exporter

Extensão Chrome (Manifest V3) para exportar os itens salvos no Instagram — incluindo carrossel completo e vídeo — usando a sua sessão já logada.

**Novo:** botão **Gerar SQL para Looks** que cria um `INSERT INTO pecas` pronto para colar no Supabase.

## Como instala

1. Abra `chrome://extensions`
2. Ative o **Modo do desenvolvedor**
3. Clique em **Carregar sem compactação**
4. Selecione a pasta deste repositório

## Como usa

1. Vá em Instagram já logado e abra a coleção de Salvos.
2. Clique no ícone da extensão.
3. **Auto-scroll** para capturar a grade.
4. **Enriquecer mídia completa**.
5. Clique em **Gerar SQL para Looks** → baixa `pecas_looks.sql`.
6. Cole o arquivo no SQL Editor do Supabase e rode.

## Estrutura

- `popup.html` / `popup.js` — interface
- `content.js` — captura da grade de Salvos
- `background.js` — fila de enriquecimento e download
- `post-reader.js` — lê mídia completa de cada post
