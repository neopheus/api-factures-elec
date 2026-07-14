import { SignupForm } from '../../../components/signup-form'

export default function SignupPage() {
  return (
    <main>
      <h1>Créer un compte</h1>
      <SignupForm />
      <a href="/login">J'ai déjà un compte</a>
    </main>
  )
}
