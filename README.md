# Rally Team Online — protótipo funcional

Protótipo web multiplayer para 1–4 duplas (2–8 jogadores), com Node.js + Express + Socket.IO.

## Fluxo
`device.html` → entrada/criação → lobby → preparação → contagem 10s → corrida → resultado.

## Rodar localmente
```bash
npm install
npm start
```
Abra `http://localhost:3000/device.html`.

Para testar sozinho, abra duas janelas/perfis do navegador, crie uma sala em uma e entre com o código na outra. Escolha a mesma cor, com um Piloto e um Copiloto.

## Regras implementadas
- 4 cores de equipe, com exatamente 1 Piloto + 1 Copiloto por cor.
- 1 a 4 duplas por partida.
- Dificuldade Fácil/Difícil definida pelo anfitrião.
- Pista procedural fechada e horária, igual para todas as duplas.
- Pista combina segmentos retos e curvas leves/médias/fechadas.
- Piloto não recebe a geometria da pista durante a etapa; vê apenas início e folha.
- Copiloto vê a pista e o desenho do parceiro ao vivo.
- Desenho e borracha com mouse ou toque; trocar de ferramenta não apaga nem reconstrói o traço.
- Borracha com espessura exatamente 5× maior que a ponta da caneta.
- 4 fichas +5 manuais: o Copiloto pega a próxima ficha quando considerar que o desenho chegou corretamente à linha; a primeira dupla a pegá-la bloqueia a ficha para todas as demais.
- Piloto ou Copiloto encerra a corrida da dupla pelo botão **Concluímos**; o tempo é registrado e o desenho é bloqueado.
- A pontuação só é calculada e exibida quando todas as duplas tiverem pressionado **Concluímos**.
- Pontuação de precisão 0–100 calculada no servidor por sobreposição espacial em uma folha virtual A5, com tolerância por dificuldade.
- Total = precisão + bônus. Empate = menor tempo.
- Resultado mostra pista original e desenho de cada dupla.
- Reiniciar gera nova pista mantendo sala/equipes; sair retorna à entrada.
- Reconexão de sessão via token local enquanto o servidor permanecer ativo.
- Sala vazia é removida após 10 minutos.

## Deploy no Render
- Build command: `npm install`
- Start command: `npm start`
- Node 20+.
- Opcional: defina `PUBLIC_ORIGIN` com a URL pública do site para restringir a origem do Socket.IO.

## Observação do protótipo
As salas ficam em memória. Um reinício do servidor encerra as salas ativas. Não há ranking nem MongoDB nesta versão.


### Ajuste visual v3
- A folha do Piloto não exibe linhas de quadrante nem para o Piloto nem para o Copiloto.
- Os quadrantes continuam existindo somente na lógica interna.
- A folha visível mostra apenas o ponto de início e o traço do Piloto.
- A tela final também preserva a folha lisa, sem cruz de quadrantes.


## v4 — correção de conclusão
- Corrigido o fluxo do botão **Concluímos**, inclusive para partidas com uma única dupla.
- A última dupla a concluir leva a sala diretamente ao resultado em uma única transição de estado.
- O botão passa imediatamente para **Concluindo…** enquanto o servidor confirma a ação.
- O evento auxiliar de conclusão não força mais uma renderização intermediária no cliente.
