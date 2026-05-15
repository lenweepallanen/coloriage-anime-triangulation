export default function PlayHomePage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: 24, textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Coloriage Animé</h1>
      <p style={{ maxWidth: 480, color: '#555' }}>
        Scannez le QR code de votre livre pour découvrir l'animation associée à votre coloriage.
      </p>
    </div>
  )
}
