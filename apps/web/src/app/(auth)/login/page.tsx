import { LoginForm } from '../../../components/login-form'

export default function LoginPage() {
  return (
    <main>
      <h1>Connexion</h1>
      <LoginForm />
      <a href="/signup">Créer un compte</a>
    </main>
  )
}
