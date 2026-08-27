<Frame name="Bridge Fidelity Corpus v1" flex="col" w="960" gap="24" p="32" bg="var:color/surface" radius="20" filter="drop-shadow(0 8px 24px #0f172a33) drop-shadow(0 2px 8px #0f172a1f)">
  <Frame name="Header" flex="row" w="fill" justify="between" items="center" gap="16">
    <Frame name="Title group" flex="col" w="fill" gap="6">
      <Text name="Title" w="fill" size="28" weight="400" lineHeight="34px" color="var:color/text">Bidirectional <strong>fidelity</strong></Text>
      <Text name="Description" w="fill" size="15" lineHeight="22px" color="var:color/muted">One redistributable fixture for structural, semantic, visual and operational evidence.</Text>
    </Frame>
    <Icon name="bridge-glyph" w="72" h="72" />
  </Frame>
  <Frame name="Responsive content" flex="row" w="fill" minW="560" maxW="960" gap="16">
    <Frame name="Token card" flex="col" w="fill" gap="12" p="20" bg="#FFFFFF" radius="14" stroke="var:color/border" strokeWidth="1">
      <Text name="Token label" size="13" weight="700" color="var:color/accent">ALIASED TOKEN</Text>
      <Text name="Token value" size="18" weight="600" color="var:color/text">space/card → space/base</Text>
    </Frame>
    <Frame name="Masked artwork" flex="none" w="220" h="132" overflow="hidden" radius="14" bg="#DBEAFE">
      <Ellipse name="Alpha mask" x="36" y="12" w="120" h="120" bg="#FFFFFF" mask="alpha" />
      <Rect name="Masked color" x="0" y="0" w="220" h="132" bg="var:color/accent" />
    </Frame>
  </Frame>
  <Instance name="Corpus control" entity="corpus.control" variant="State=Ready, Size=Medium" w="180" />
</Frame>
