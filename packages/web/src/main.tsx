import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { DocListPage } from './pages/DocList'
import { EditorPage } from './pages/Editor'
import './style.css'

const router = createBrowserRouter([
  { path: '/', element: <DocListPage /> },
  { path: '/d/:id', element: <EditorPage /> },
])

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />)
